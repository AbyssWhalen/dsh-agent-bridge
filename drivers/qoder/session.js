/**
 * The Qoder worker-runtime session: one child process, driven over the
 * `stream-json` control channel the desktop app itself uses.
 *
 * ## Why a subprocess rather than an HTTP client
 *
 * The public Qoder endpoints reject a third-party model request: the gateway
 * answers `503` for `/api/v2/model/list` and `/model/v1/chat/completions`
 * while serving `/api/v2/quota/usage` normally, and the model server is not
 * reachable off the desktop transport at all. The app's bundled worker runtime
 * *does* reach it — it resolves the inference endpoint, signs the request and
 * holds the transport — so the only honest way to proxy these models is to run
 * that runtime and speak its protocol.
 *
 * ## The protocol
 *
 * The runtime runs `--input-format stream-json --output-format stream-json`.
 * The host writes newline-delimited JSON to stdin and reads the same from
 * stdout. Two families matter here:
 *
 * - **`control_request`** (child → host) asks the host for something it alone
 *   can provide. `fetch_job_token` is the one that authenticates the session:
 *   the host mints a job token from the desktop credential and answers with
 *   `control_response`. Anything else is answered with an empty success, so an
 *   unknown request never wedges the child.
 * - **`stream_event` / `assistant` / `result`** carry the turn. With
 *   `--include-partial-messages`, `stream_event` wraps Anthropic-shaped
 *   `content_block_delta` events, which is what makes true token streaming
 *   possible instead of waiting for the final message.
 *
 * `initialize` is sent by the host after spawn and is what pins the model and
 * the reasoning effort for the session; `set_model` retargets a live session.
 *
 * @module dsh-agent-bridge/drivers/qoder/session
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintJobToken } from './upstream.js';

/** Control-channel reply deadline. Generous: it covers a cold token mint. */
const CONTROL_TIMEOUT_MS = 30000;

/**
 * How many times a cold listing asks for the catalog before believing "empty".
 *
 * Each attempt is a live fetch, so the cost of being wrong here is a slow
 * first render, not a wrong answer.
 */
const CATALOG_ATTEMPTS = 6;

/** Pause between catalog attempts, in milliseconds. */
const CATALOG_RETRY_MS = 1000;

/** Resolve after a delay. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** How long a session may sit idle before it is reaped. */
const IDLE_TEARDOWN_MS = 5 * 60 * 1000;

/**
 * How long a catalog answer is trusted, in milliseconds.
 *
 * Entitlements move while the host runs: a trial ends, a package is added, a
 * model is retired for the account. Caching the first non-empty answer for the
 * life of the child meant the plugin kept reporting a roster the account no
 * longer had — the exact failure that makes this plugin useless, because the
 * point of it is to serve whatever the account can use *now*.
 *
 * So a cached catalog expires. It is a span rather than a count of calls: the
 * caller asks on its own cadence, and what matters is how old the answer is.
 */
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Reasoning levels the runtime accepts on `--reasoning-effort`, in ascending
 * order. `off` is not a runtime level — it is the absence of one, and the runtime
 * spells that `none` on its control channel and `--thinking disabled` on argv.
 */
export const RUNTIME_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * One harness effort id as the runtime's control value.
 *
 * `off` is the harness's word for "do not think", which the runtime calls `none`
 * on `reasoningEffort`. Passing the literal `off` through would be rejected, and
 * dropping it would make the picker's Off choice do nothing.
 *
 * @param {string | undefined} effort
 * @returns {string | undefined} `undefined` when no choice was expressed.
 */
export function controlEffort(effort) {
  if (effort === 'off') return 'none';
  return typeof effort === 'string' && effort.length > 0 ? effort : undefined;
}

/**
 * Options the host passes to the worker runtime.
 *
 * `--tools` is deliberately emptied: this plugin proxies a *model*, and a
 * coding agent's tool belt would put file writes behind a chat completion.
 * The system prompt is replaced rather than appended for the same reason.
 */
function runtimeArgs(options) {
  const args = [
    options.runtimePath,
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--no-session-persistence',
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--disallowed-tools',
    '*',
    '--tools',
    '',
    '--disable-builtin-skills'
  ];
  if (typeof options.model === 'string' && options.model.length > 0) args.push('--model', options.model);
  if (options.reasoningEffort === 'off') {
    args.push('--thinking', 'disabled');
  } else if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
    args.push('--reasoning-effort', options.reasoningEffort);
  }
  return args;
}

/**
 * A live worker-runtime session.
 *
 * One session maps to one child process and one conversation. The DSH host
 * decides when a conversation is new; this class only guarantees that a
 * message sent to it reaches the right child and that its events are routed
 * back.
 */
export class QoderSession {
  #child;
  #options;
  #buffer = '';
  #pending = new Map();
  #payloadDir;
  #jobToken;
  #closed = false;
  /** Set once the child process is gone, however it went. See {@link alive}. */
  #died = false;
  #exited;
  #idleTimer;
  #startedAt;
  #turn;
  /** Last catalog the runtime reported, with the instant it was read. */
  #catalog;
  #catalogAtMs;
  /** How long a cached catalog is honoured; injectable so a test need not wait. */
  #catalogTtlMs;
  /** Where raw frames are appended, from `DSH_BRIDGE_DUMP_FRAMES`. */
  #dumpPath;

  /** Model id currently pinned on the child. */
  model;
  /** Reasoning effort currently pinned on the child, when the model takes one. */
  reasoningEffort;
  /** Whether `initialize` has completed for this child. */
  ready = false;

  /**
   * Event sink for everything that is not a control frame.
   *
   * Assignable rather than a constructor option because the owner changes per
   * turn: the adapter points it at the active turn's queue and leaves it in
   * place between turns, where events are simply ignored.
   */
  onEvent = () => {};

  /** Fatal-error sink. Also assignable per turn. */
  onError = () => {};

  constructor(options) {
    this.#options = options;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.#catalogTtlMs = typeof options.catalogTtlMs === 'number' ? options.catalogTtlMs : CATALOG_TTL_MS;
    const dump = process.env.DSH_BRIDGE_DUMP_FRAMES;
    this.#dumpPath = typeof dump === 'string' && dump.length > 0 ? dump : undefined;
    this.#start();
  }

  /**
   * Write the host auth payload and start the child.
   *
   * The payload file is the app's own handshake: a JSON document naming the
   * auth mode (`jobToken`, supplied by the host). The runtime deletes the file
   * itself once read, so the directory it lives in is disposable and is
   * removed on exit.
   */
  #start() {
    this.#payloadDir = mkdtempSync(join(tmpdir(), 'dsh-qoder-auth-'));
    const payloadPath = join(this.#payloadDir, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify({ type: 'jobToken', jobTokenProvider: 'host' }), { mode: 0o600 });

    const child = spawn(process.execPath, runtimeArgs(this.#options), {
      cwd: this.#options.cwd,
      env: {
        ...process.env,
        QODER_SDK_AUTH_PAYLOAD_FILE: payloadPath,
        QODER_SDK_AUTH_CONFIG_DIR: this.#payloadDir,
        QODER_AGENT_SDK_ENTRYPOINT: '1',
        ...(this.#options.sdkVersion === undefined ? {} : { QODER_AGENT_SDK_VERSION: this.#options.sdkVersion }),
        QODER_AGENT_SDK_LANGUAGE: 'en'
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.#child = child;
    this.#startedAt = Date.now();
    this.#touchIdle();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text.length > 0) this.#options.logger?.debug?.(`qoder: worker stderr: ${text.slice(0, 400)}`);
    });

    this.#exited = new Promise((resolve) => {
      child.once('error', (error) => {
        this.#died = true;
        this.ready = false;
        this.#fail(new Error(`qoder: worker runtime failed to start: ${String(error)}`));
        resolve({ code: -1, error });
      });
      child.once('exit', (code, signal) => {
        const unexpected = !this.#closed;
        // The process is gone either way, so the session is spent. `ready` has to say
        // so: it is what the caller checks before deciding whether a child still needs
        // to be told what it is, and a stale `true` made every later turn write into a
        // destroyed pipe and then wait for an answer that could not arrive.
        this.#died = true;
        this.ready = false;
        this.#cleanupPayload();
        for (const pending of this.#pending.values()) pending.reject(new Error('qoder: worker runtime exited before replying'));
        this.#pending.clear();
        if (unexpected) this.#fail(new Error(`qoder: worker runtime exited unexpectedly (code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`})`));
        resolve({ code, signal });
      });
    });
  }

  /**
   * Whether this session still has a child process behind it.
   *
   * A session is the lifetime of one child, not a reconnecting client. Callers use this
   * to decide whether to replace it; see `QoderConversation#ensureChild` for the failure
   * that made it necessary.
   *
   * @returns {boolean}
   */
  get alive() {
    return !this.#closed && !this.#died;
  }

  /** Remove the one-shot auth payload directory. */
  #cleanupPayload() {
    if (this.#payloadDir === undefined) return;
    try {
      rmSync(this.#payloadDir, { recursive: true, force: true });
    } catch {
      /* a leaked temp file is not worth failing a turn over */
    }
    this.#payloadDir = undefined;
  }

  /** Reset the idle reaper; called on every sign of life. */
  #touchIdle() {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close(), IDLE_TEARDOWN_MS);
    this.#idleTimer.unref?.();
  }

  /** Surface a fatal condition once; later calls are no-ops. */
  #fail(error) {
    if (this.#closed) return;
    this.onError(error);
  }

  /** Split the child's stdout into JSON lines and dispatch each. */
  #consume(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#options.logger?.debug?.(`qoder: unparsed worker line: ${line.slice(0, 300)}`);
        continue;
      }
      this.#dispatch(message);
    }
  }

  /** Route one decoded worker message. */
  #dispatch(message) {
    this.#touchIdle();
    this.#dump(message);

    if (message?.type === 'control_request') {
      // `#answerControl` swallows its own failures; the catch is here anyway so that a
      // bug inside it cannot become a process-killing unhandled rejection.
      void this.#answerControl(message).catch((error) => {
        this.#options.logger?.debug?.(`qoder: control reply failed: ${String(error)}`);
      });
      return;
    }

    if (message?.type === 'control_response') {
      const id = message.response?.request_id ?? message.request_id;
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        pending.resolve(message.response ?? message);
      }
      return;
    }

    if (message?.type === 'system' && message.subtype === 'init') {
      this.#options.logger?.debug?.(`qoder: worker ready (model=${String(message.model)}, pid=${String(message.pid)})`);
      return;
    }

    // The runtime pushes the catalog once it has landed; capturing it here
    // means a later listing on this session does not need another fetch.
    if (message?.type === 'system' && message.subtype === 'available_models_update') {
      const models = message.models ?? message.data?.models;
      if (Array.isArray(models) && models.length > 0) {
        this.#catalog = models;
        this.#catalogAtMs = Date.now();
      }
      return;
    }

    this.onEvent(message);
  }

  /**
   * Append one raw frame to `DSH_BRIDGE_DUMP_FRAMES`, when that is set.
   *
   * A driver that translates a vendor's protocol is only as good as the frames it
   * was written against, and reasoning about Those from a rendered answer is
   * guesswork: the difference between "the model wrote a call we failed to parse"
   * and "the model wrote prose that looks like a call" is one field apart, and the
   * rendered text has already lost which channel it arrived on.
   *
   * So this records what arrived, verbatim, and nothing else — the file is the
   * vendor's own bytes. Off unless asked for, because it can carry prompt text.
   *
   * @param {unknown} message
   */
  #dump(message) {
    if (this.#dumpPath === undefined) return;
    try {
      appendFileSync(this.#dumpPath, `${JSON.stringify(message)}\n`);
    } catch {
      // A diagnostic that breaks the turn it is diagnosing is not worth having.
      this.#dumpPath = undefined;
    }
  }

  /**
   * Answer one child control request.
   *
   * `fetch_job_token` is the authenticated one: the host mints the token from
   * the desktop credential (cached until near expiry) and replies with it plus
   * the expiry in milliseconds, which is the shape the runtime validates.
   * Every other subtype gets an empty success — the runtime tolerates that for
   * the optional host hooks, and a missing reply would stall the turn.
   *
   * This method must never throw. The caller fires it with `void`, so a rejection
   * here has no awaiter, and Node terminates the process on an unhandled rejection —
   * one child dying at the wrong moment would take DSH down. The window is real rather
   * than theoretical: the token path awaits the credential and a network round trip,
   * and the reply is written afterwards, so a child that exits during the mint makes
   * both the success write *and* the error write fail. Measured: one rejection per
   * occurrence (`_probe/qoder-control-race.mjs`).
   *
   * A reply to a dead child is not an error to report: the child is the only thing that
   * would have read it, and its exit has already been surfaced by the `exit` handler.
   */
  async #answerControl(message) {
    const subtype = message?.request?.subtype ?? message?.request?.type;
    const requestId = message?.request_id;
    try {
      if (String(subtype) === 'fetch_job_token') {
        const token = await this.#resolveJobToken(message?.request?.reason);
        this.#send({
          type: 'control_response',
          response: { subtype: 'success', request_id: requestId, response: { token: token.token, expiresAt: token.expiresAtMs } }
        });
        return;
      }
      this.#send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
    } catch (error) {
      // Two distinct cases arrive here and only one of them is worth a log line: the
      // mint failed (the child is alive and deserves an error answer), or the write
      // failed (the child is gone and nobody is listening). Retrying the write in the
      // second case is what used to throw out of here.
      if (!this.alive) {
        this.#options.logger?.debug?.(`qoder: dropped a control reply to a child that had already exited (${String(subtype)})`);
        return;
      }
      this.#options.logger?.debug?.(`qoder: answering control request ${String(subtype)} failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        this.#send({
          type: 'control_response',
          response: { subtype: 'error', request_id: requestId, error: error instanceof Error ? error.message : String(error) }
        });
      } catch {
        /* the child went away between the check above and this write */
      }
    }
  }

  /** Mint or reuse a job token, refreshing shortly before expiry. */
  async #resolveJobToken(reason) {
    const now = Date.now();
    if (this.#jobToken !== undefined && this.#jobToken.expiresAtMs - now > 60000) return this.#jobToken;
    const credential = await this.#options.resolveCredential();
    const minted = await mintJobToken(credential, { signal: this.#options.signal });
    const expiresAtMs = (() => {
      const parsed = Date.parse(minted.expiresAt ?? '');
      return Number.isFinite(parsed) ? parsed : now + 3600000;
    })();
    this.#jobToken = { token: minted.token, expiresAtMs };
    this.#options.logger?.debug?.(`qoder: minted job token (reason=${String(reason ?? 'initial')})`);
    return this.#jobToken;
  }

  /**
   * Write one JSON line to the child.
   *
   * Throws when there is nothing to write to. The previous version returned quietly,
   * which turned "the child is gone" into "the prompt was sent" — the callers then
   * waited for a reply that could never arrive, so the failure showed up as a turn that
   * never ended rather than as an error.
   */
  #send(message) {
    if (!this.alive || this.#child.stdin.destroyed) {
      throw new Error('qoder: worker runtime is gone; the request was not sent');
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Send a control request and await its response. */
  #request(subtype, request = {}) {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`qoder: worker runtime did not answer ${subtype} within ${CONTROL_TIMEOUT_MS}ms`));
      }, CONTROL_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.#send({ type: 'control_request', request_id: requestId, request: { subtype, ...request } });
    });
  }

  /**
   * Pin the model and reasoning effort on the live child.
   *
   * Called once before the first turn. A later change goes through
   * {@link reconfigure} rather than a second `initialize`, because the runtime
   * treats a repeat `initialize` as a full re-init.
   *
   * @returns the model catalog, which may still be empty on a cold child —
   *   use {@link listModels} when the models are what is wanted.
   */
  async initialize(systemPrompt) {
    this.#touchIdle();
    const request = { model: this.model, permissionMode: 'bypassPermissions' };
    const effort = controlEffort(this.reasoningEffort);
    if (effort !== undefined) request.reasoningEffort = effort;
    if (typeof systemPrompt === 'string' && systemPrompt.length > 0) request.systemPrompt = systemPrompt;
    const response = await this.#request('initialize', request);
    this.ready = true;
    const models = response?.response?.models;
    return Array.isArray(models) ? models : [];
  }

  /**
   * The model catalog the runtime reports for this account.
   *
   * This is upstream truth — the account's live entitlements, per-model
   * reasoning levels and context windows — not a hard-coded table.
   *
   * Two quirks drive the shape of this method, both observed on a cold child:
   *
   * 1. The default `fetchStrategy` is `cache`, and the cache path is skipped
   *    entirely while the account uid has not landed yet — which it has not,
   *    for about a second after `initialize`. That combination answers `0`
   *    models and would leave the route advertising nothing on first boot, so
   *    the listing asks for `live` explicitly.
   * 2. Even a live fetch can race the runtime's own startup, so an empty
   *    answer is retried a few times before it is believed.
   *
   * A genuinely empty account settles on the last answer, which is what hides
   * the provider until the desktop app is signed in.
   *
   * A non-empty answer is cached, but only for {@link CATALOG_TTL_MS}: the point
   * of caching is to keep a warm child answering instantly, not to freeze the
   * roster. See {@link CATALOG_TTL_MS} for what freezing cost.
   */
  async listModels() {
    if (this.#catalogIsFresh()) return this.#catalog;
    for (let attempt = 0; attempt < CATALOG_ATTEMPTS; attempt += 1) {
      const response = await this.#request('get_models', { fetchStrategy: 'live' });
      const models = response?.response?.models;
      if (Array.isArray(models) && models.length > 0) {
        this.#remember(models);
        return models;
      }
      if (attempt < CATALOG_ATTEMPTS - 1) await delay(CATALOG_RETRY_MS);
    }
    this.#catalog = [];
    this.#catalogAtMs = undefined;
    return this.#catalog;
  }

  /**
   * Whether the cached catalog is still worth honouring.
   *
   * An empty answer is never cached: the account may simply not be signed in yet,
   * and the empty state is what hides the provider, so it has to be re-asked.
   *
   * @returns {boolean}
   */
  #catalogIsFresh() {
    if (this.#catalog === undefined || this.#catalog.length === 0) return false;
    if (this.#catalogAtMs === undefined) return false;
    return Date.now() - this.#catalogAtMs < this.#catalogTtlMs;
  }

  /**
   * Adopt a listing as the cached one, stamped with the instant it was read.
   *
   * @param {object[]} models
   */
  #remember(models) {
    this.#catalog = models;
    this.#catalogAtMs = Date.now();
  }

  /** Retarget a live session at another model or effort level. */
  async reconfigure(model, reasoningEffort) {
    this.#touchIdle();
    const request = {};
    if (model !== undefined && model !== this.model) {
      request.model = model;
      this.model = model;
    }
    if (reasoningEffort !== this.reasoningEffort) {
      request.reasoningEffort = controlEffort(reasoningEffort) ?? null;
      this.reasoningEffort = reasoningEffort;
    }
    if (Object.keys(request).length === 0) return;
    await this.#request('set_model', request);
  }

  /**
   * Send one user prompt.
   *
   * The runtime reports the end of the turn with its `result` event, which the
   * adapter watches for; this method therefore resolves as soon as the prompt
   * is written. `busy` stays true until {@link endTurn} is called, so a second
   * turn cannot be interleaved into the same conversation.
   */
  async send(prompt) {
    this.#touchIdle();
    this.#turn = randomUUID();
    this.#send({ type: 'user', message: { role: 'user', content: prompt } });
  }

  /**
   * Mark the in-flight turn finished.
   *
   * Called by the adapter when it sees the turn's `result` (or when its own
   * stream ends), which is what frees the conversation for the next message.
   */
  endTurn() {
    this.#turn = undefined;
  }

  /** Interrupt the in-flight turn, leaving the session usable. */
  async interrupt() {
    this.#touchIdle();
    try {
      await this.#request('interrupt', {});
    } catch (error) {
      this.#options.logger?.debug?.(`qoder: interrupt failed: ${String(error)}`);
    }
  }

  /** Whether a turn is currently in flight. */
  get busy() {
    return this.#turn !== undefined;
  }

  /** Milliseconds since the child was spawned. */
  get age() {
    return Date.now() - (this.#startedAt ?? Date.now());
  }

  /** Terminate the child and release its temporary payload directory. */
  close() {
    if (this.#closed) return this.#exited ?? Promise.resolve();
    this.#closed = true;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    try {
      this.#child.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      this.#child.kill();
    } catch {
      /* already gone */
    }
    this.#cleanupPayload();
    return this.#exited ?? Promise.resolve();
  }
}

