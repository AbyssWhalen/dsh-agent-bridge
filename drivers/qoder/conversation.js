/**
 * One Qoder conversation: a worker child process plus the turn machinery that
 * turns its push events into the harness's chunk union.
 *
 * ## Why a child process rather than an HTTP client
 *
 * The public Qoder endpoints reject a third-party model request: the gateway
 * answers `503` for `/api/v2/model/list` and `/model/v1/chat/completions` while
 * serving `/api/v2/quota/usage` normally, and the model server is not reachable
 * off the desktop transport at all. The app's bundled worker runtime *does*
 * reach it — it resolves the inference endpoint, signs the request, and holds the
 * transport — so the only honest way to proxy these models is to run that runtime
 * and speak its protocol.
 *
 * ## History
 *
 * The runtime keeps its own conversation history, which is what makes a follow-up
 * turn cheap (about 1.6 s warm against about 6 s cold). The harness's `stream()`
 * contract is stateless, though: every call carries the whole message list. This
 * class reconciles the two. When the incoming list is the previous list plus one
 * trailing user turn *and* the system prompt is unchanged, only that turn is sent.
 * Any other change — an edit, a compaction, a fork — means the child's history no
 * longer describes the request, and the session is rebuilt with the flattened
 * transcript as a single prompt instead.
 *
 * @module dsh-agent-bridge/drivers/qoder/conversation
 */
import { QoderSession } from './session.js';
import {
  endsWithMarkerPrefix,
  hasLeak,
  hasNativeLeak,
  hasUnclosedCallMarkup,
  isDegenerate,
  MARKER_MAX,
  parseLeakedCalls,
  stripLeak,
  truncateOpenMarkup
} from '../../lib/dsml.js';
import { emptyTurn, noticedFailure } from '../../lib/failure.js';
import { appendPrompt, flattenTranscript, isStraightAppend, messageFingerprint, splitSystem } from '../../lib/messages.js';

/**
 * The runtime announces a saturated queue as an ordinary answer, so the opening
 * characters of a reply cannot be forwarded immediately: a notice has to become an
 * error instead of appearing as the model's own words.
 */

/**
 * What the runtime says instead of an answer, as lower-cased stems.
 *
 * Trailing text is why these are stems and not whole sentences. The allowance notice arrives
 * as
 *
 *     You've reached your daily usage limit for Chat. Come back tomorrow to continue working
 *     with me. Report Issue (input /feedback)
 *
 * — the runtime appends a support hint. An exact match on any fixed wording misses the real
 * wire text, and the miss is silent: the notice becomes the assistant's answer, is shown as
 * if the model wrote it, and is replayed as history on the next turn. `capture15` was
 * thirteen turns of that, each reported as a success.
 *
 * Matching is anchored at the start, so an ordinary answer that merely mentions the words
 * (`The daily usage limit for Chat is 2900 credits.`) is still an answer.
 *
 * `kind` is the failure the notice stands for, in this driver's vocabulary — see
 * {@link serviceNotice}. The allowance one is `quota`, not a rate limit: no amount of retrying
 * clears it before the counter resets.
 */
const SERVICE_NOTICE_STEMS = [
  { stem: 'the model is busy and could not complete the request', kind: 'soft_rate' },
  { stem: 'queuing failed', kind: 'soft_rate' },
  { stem: "you've reached your daily usage limit", kind: 'quota' }
];

/**
 * How much text may follow a notice stem and still be treated as part of the notice.
 *
 * The runtime appends a support hint (`Report Issue (input /feedback)`, about 30 characters)
 * and the allowance notice carries a trailing sentence of its own, so some slack is needed.
 * The bound matters as much as the slack: an *answer* that happens to open with one of these
 * sentences is released once it grows past the bound, and is then treated as the answer it
 * is. Without a bound the hold would last to the end of the turn and every such answer would
 * be reported as an upstream failure.
 */
const SERVICE_NOTICE_TAIL_SLACK = 120;

/**
 * How long a turn may go without a single frame before it is declared stalled.
 *
 * The WorkBuddy driver has had this guard for a while; this one had none, so a worker that
 * streamed one delta and then neither finished nor died left the turn in `await queue.next()`
 * with nothing to wake it. Measured against `fake-silent-runtime.mjs`: the consumer was still
 * waiting four seconds later, and would have waited forever. A failure the harness can classify
 * is strictly better than a hang, because a hang never reaches the retry policy and never
 * appears in the session log.
 *
 * It is a *deadline*, not an interval: every frame pushes it forward, so a long turn that keeps
 * producing events can never be killed by the clock. The number is the same five minutes as the
 * other driver's, for the same reason — generous enough for a model that thinks for a long time
 * before its first token, short enough that a dead connection is noticed within a turn.
 */
export const TURN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long a turn may sit in the vendor's model queue before it is reported as a timeout.
 *
 * The worker does not serve a request immediately: it parks it behind every other request on
 * the same model and sends `model_queue_status` heartbeats while it waits. Measured on
 * `dfmodel`: `queue_count: 9741`, `wait_time_ms: 3261000` — fifty-four minutes, with the
 * service itself advertising `queue_max_wait_ms: 3600000` (an hour).
 *
 * Two separate faults came out of ignoring those frames, and this budget is the second one's
 * fix. First, the heartbeat pushes the stall deadline forward like any other frame, so
 * {@link TURN_IDLE_TIMEOUT_MS} can never expire: a queued turn is silent, reports nothing,
 * and never fails. Second, an hour of that is indistinguishable from a hang, which is what
 * the caller sees — a turn whose output is blocked with no explanation and no error.
 *
 * Fifteen minutes is a judgement, not a wire fact: long enough to ride out the ordinary
 * queue, short enough that the caller gets an answer it can act on. The failure is `timeout`,
 * which resolves to `TIMEOUT` and is retryable, so the harness's own retry covers the rest of
 * the wait instead of this file blocking on it.
 */
export const QUEUE_WAIT_BUDGET_MS = 15 * 60 * 1000;

/**
 * Render one queue-status frame as the sentence a person needs to read.
 *
 * Silence is the thing being fixed, so this has to say three things: that nothing is wrong,
 * where the request actually is, and how long the wait is. Numbers are formatted rather than
 * interpolated raw — `3261000` is not a duration to anyone reading it.
 *
 * @param {{queueCount?: number, waitMs?: number}} state
 * @returns {string}
 */
export function queueSentence(state) {
  const parts = [];
  if (Number.isFinite(state.queueCount) && state.queueCount > 0) {
    parts.push(`${state.queueCount} request${state.queueCount === 1 ? '' : 's'} ahead`);
  }
  if (Number.isFinite(state.waitMs) && state.waitMs > 0) {
    const minutes = Math.round(state.waitMs / 60_000);
    parts.push(`roughly ${minutes} minute${minutes === 1 ? '' : 's'} to go`);
  }
  if (parts.length === 0) return 'qoder: waiting in the model queue';
  return `qoder: queued behind the vendor's model — ${parts.join(', ')}`;
}

/**
 * Whether text is still on course to be a service notice.
 *
 * Used as a hold predicate: while it holds, nothing is emitted, because the text may still
 * turn out to be a notice, and once emitted a notice cannot be taken back.
 *
 * Two windows, not one. Text is on course while it is still a prefix of a stem (`the model i`
 * → `the model is busy…`), **and** while it is a stem followed by a short tail (the finished
 * notice plus whatever the runtime added after it). Matching only the first window was the
 * original shape of this function and it cannot work with stems: the moment the notice grew
 * one character past its stem the hold ended, the notice was released as the model's answer,
 * and the exact-match check at the end of the turn had nothing left to inspect.
 *
 * @param {string} held
 * @returns {boolean}
 */
function couldBeServiceNotice(held) {
  const lowered = held.trimStart().toLowerCase();
  for (const { stem } of SERVICE_NOTICE_STEMS) {
    if (stem.startsWith(lowered)) return true;
    if (lowered.startsWith(stem) && lowered.length - stem.length <= SERVICE_NOTICE_TAIL_SLACK) return true;
  }
  return false;
}

/**
 * Whether text is a service notice, and which kind of failure it stands for.
 *
 * The kind travels with the stem because the two notices mean different things to the caller.
 * "Busy, try again" is transient and worth retrying; "you are out of Chat for today" is not —
 * retrying spends nothing but time and cannot succeed before tomorrow. Reporting both as one
 * unclassified failure is what let the second one sit in the harness log as an anonymous
 * error, and it is what a reader of that log cannot tell apart from a genuine fault.
 *
 * Nothing held is not a notice: the empty string is a prefix of every stem, so without the
 * length guard an empty reply would be reported as an upstream failure with no message.
 *
 * @param {string} held
 * @returns {{stem: string, kind: string} | undefined}
 */
function serviceNotice(held) {
  const lowered = held.trim().toLowerCase();
  if (lowered.length === 0) return undefined;
  return SERVICE_NOTICE_STEMS.find((notice) => lowered.startsWith(notice.stem));
}

/**
 * The tool section appended to the system prompt.
 *
 * The worker runs with its tool belt emptied, so the model has no native way to
 * call anything — and the harness's tool declarations used to be dropped on the
 * floor here. The model then did what a DeepSeek-family model does when asked to
 * run something it cannot run: it wrote its own call syntax as prose, which reached
 * the screen as `<｜｜DSML｜｜ invoke>` and never executed.
 *
 * So the declarations are made explicit, in the exact syntax this model already
 * produces, and the stream translator turns that syntax back into a real call.
 * Naming the tools exactly is the part that matters: without it the model invents
 * names like `Bash`, which no amount of recovery can map onto a real tool.
 *
 * @param {readonly {name: string, description?: string, parameters?: object}[]} tools
 * @returns {string}
 */
export function toolPreamble(tools) {
  const lines = [
    '',
    '# Calling tools',
    '',
    'You can run tools. To call one, reply with exactly this markup and nothing else:',
    '',
    '<｜｜DSML｜｜ invoke name="TOOL_NAME">',
    '<｜｜DSML｜｜ arguments>{"PARAMETER_NAME": "VALUE"}</｜｜DSML｜｜ arguments>',
    '</｜｜DSML｜｜ invoke>',
    '',
    'The part between `<｜｜DSML｜｜ arguments>` and `</｜｜DSML｜｜ arguments>` is one JSON',
    'object: quote every string, close every brace, and put every parameter inside it. Do not',
    'write a separate tag per parameter — one object holds them all.',
    '',
    '`TOOL_NAME`, `PARAMETER_NAME` and `VALUE` are placeholders: replace them. A reply that',
    'still contains the words `TOOL_NAME` or `PARAMETER_NAME` calls nothing.',
    '',
    'The markup is a wire format, not an answer. Never explain it, never describe it, never',
    'quote it back, and never show it to the reader unless you are actually calling a tool.',
    'When no tool is needed, answer in ordinary prose and use no markup at all.',
    '',
    'Use these names exactly. Never invent a tool name, and never guess at a',
    'parameter name. After emitting a call, stop: the result arrives as the next',
    'turn. If no tool is needed, answer in plain prose as usual.',
    ''
  ];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`);
    if (typeof tool.description === 'string' && tool.description.length > 0) lines.push(tool.description.trim());
    const parameters = tool.parameters;
    const properties = parameters?.properties;
    if (properties !== null && typeof properties === 'object') {
      const required = new Set(Array.isArray(parameters.required) ? parameters.required : []);
      lines.push('');
      lines.push('Parameters:');
      for (const [name, schema] of Object.entries(properties)) {
        const type = typeof schema?.type === 'string' ? schema.type : 'value';
        const must = required.has(name) ? ', required' : '';
        const note = typeof schema?.description === 'string' ? ` — ${schema.description}` : '';
        lines.push(`- ${name} (${type}${must})${note}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * A push queue drained by an async generator.
 *
 * The child's events arrive as callbacks while the harness pulls chunks, so
 * something has to sit between them. A queue rather than a promise chain because
 * one turn produces many chunks in burst order, and ordering is the whole point.
 *
 * ## A failure must wake the reader with a failure
 *
 * A waiter is stored as a resolver *and* a rejecter. The first version stored only
 * the resolver and answered `{ done: true }` on `fail()`, which read as "the turn
 * ended normally" — and since a streaming turn has a waiter parked almost all the
 * time, that was not an edge case but the normal path for every mid-turn fault:
 * an upstream error, a cancellation, a worker that died. The turn then closed as if
 * it had simply finished, so the caller saw a short answer instead of an error, and
 * nothing anywhere reported what happened.
 *
 * `next()` still checks the recorded error before the closed flag, so a consumer
 * that arrives after the failure also sees the failure.
 */
class AsyncQueue {
  #items = [];
  #waiters = [];
  #closed = false;
  #error;

  push(item) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: item });
      return;
    }
    this.#items.push(item);
  }

  fail(error) {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true });
  }

  /** The next chunk, or `{done: true}` once the turn ends. */
  next() {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

/**
 * One conversation with the Qoder runtime.
 *
 * Opened by the host's session pool and discarded when a turn fails, because a
 * session whose last turn did not finish cannot be trusted to continue a history
 * this class no longer knows the shape of.
 */
export class QoderConversation {
  #session;
  /** Everything needed to spawn a replacement child; see {@link #ensureChild}. */
  #spawnOptions;
  #logger;
  #idleTimeoutMs;
  #closed = false;
  /** Fingerprints of the projected messages the child's history now reflects. */
  #sent = [];
  /** The system prompt `initialize` was last given. */
  #systemPrompt = '';
  /**
   * How to end a turn that is in flight, while one is.
   *
   * Killing the child is not enough to end a turn: the streaming generator is waiting on its
   * own queue, and a queue nobody closes is waited on forever. So the turn registers its own
   * ending here for as long as it runs, and {@link close} calls it. Measured before this
   * existed: `close()` during a turn left the consumer waiting past 3s with no error and no
   * end — the reported shape is a hung turn with nothing to act on.
   */
  #endTurn;

  /**
   * @param {object} options
   * @param {string} options.runtimePath - the app's own worker runtime entry.
   * @param {string} [options.sdkVersion]
   * @param {string} [options.cwd]
   * @param {() => Promise<object>} options.resolveCredential
   * @param {number} [options.catalogTtlMs] - how long a listing is reused; tests
   *   pass a small value instead of waiting out the shipped one.
   * @param {number} [options.idleTimeoutMs] - how long a turn may go without a frame before it
   *   is declared stalled; defaults to {@link TURN_IDLE_TIMEOUT_MS}. No caller in this plugin
   *   sets it — a test uses it to reach the guard in milliseconds instead of minutes.
   * @param {{debug?: Function, info?: Function, warn?: Function}} [options.logger]
   */
  constructor(options) {
    this.#logger = options.logger;
    this.#idleTimeoutMs =
      Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0
        ? options.idleTimeoutMs
        : TURN_IDLE_TIMEOUT_MS;
    this.#spawnOptions = {
      runtimePath: options.runtimePath,
      sdkVersion: options.sdkVersion,
      cwd: options.cwd ?? process.cwd(),
      resolveCredential: options.resolveCredential,
      catalogTtlMs: options.catalogTtlMs,
      logger: options.logger
    };
    this.#session = new QoderSession(this.#spawnOptions);
  }

  /**
   * Make sure there is a live child, replacing it when the last one died.
   *
   * A `QoderSession` is the lifetime of **one** child process, not a reconnecting
   * client: once the process is gone there is nothing left to talk to. Before this
   * existed, a child that exited between turns left `ready` true, so the next turn
   * skipped `initialize`, wrote its prompt into a destroyed stdin — where `#send()`
   * dropped it without a word — and then waited for a reply that could never come.
   * Measured: every turn after the crash hung indefinitely, delivering nothing and
   * reporting nothing (`_probe/qoder-child-crash.mjs`).
   *
   * Both pieces of remembered state go with the child. `#systemPrompt` because a new
   * process has been told nothing, and `#sent` because its history is empty — keeping
   * either would make the next turn append a lone message to a stranger.
   *
   * @returns {boolean} whether a replacement was spawned.
   */
  #ensureChild() {
    if (this.#session.alive) return false;
    this.#logger?.warn?.('qoder: worker runtime is gone; starting a replacement');
    this.#session = new QoderSession(this.#spawnOptions);
    this.#systemPrompt = '';
    this.#sent.length = 0;
    return true;
  }

  /** The runtime's own model listing, read over this conversation's transport. */
  async listModels() {
    this.#ensureChild();
    if (!this.#session.ready) await this.#session.initialize('');
    return this.#session.listModels();
  }

  /** Whether this conversation has already told the runtime what it is. */
  get ready() {
    return this.#session.ready;
  }

  /**
   * Run one turn and yield the harness's chunks.
   *
   * @param {readonly {role: string, text: string}[]} messages - the projected
   *   conversation, the host's preamble already included.
   * @param {{model?: string, effort?: string, signal?: AbortSignal}} options
   * @returns {AsyncGenerator<object>}
   */
  async *send(messages, options = {}) {
    if (this.#closed) throw new Error('qoder: conversation is closed');
    // A dead child cannot be revived, so it is replaced before anything reads the
    // state it left behind. This also makes `ready` false below, which is what
    // re-establishes the framing and empties `#sent`.
    this.#ensureChild();
    const { system, rest } = splitSystem(messages);
    const tools = Array.isArray(options.tools)
      ? options.tools.filter((tool) => typeof tool?.name === 'string' && tool.name.length > 0)
      : [];
    // The tool section is part of the prompt identity: adding or removing a tool
    // changes what the model was told, so it has to force a re-initialize rather
    // than ride on a child that was primed with a different list.
    const framing = tools.length === 0 ? system : `${system}\n${toolPreamble(tools)}`;
    const append = this.#systemPrompt === framing && isStraightAppend(this.#sent, rest);

    if (!this.#session.ready || this.#systemPrompt !== framing) {
      await this.#session.initialize(framing);
      this.#systemPrompt = framing;
      // A freshly initialized child has no history, so nothing can be appended to
      // it regardless of what the fingerprints say.
      this.#sent.length = 0;
    }
    await this.#session.reconfigure(options.model, options.effort);

    // Two ways to tell the child what is new. The append branch sends only the tail —
    // a question, or the result of a call the child itself just made — and names the
    // call id so the result is not mistaken for the user speaking. The replay branch
    // renders the whole conversation **faithfully**, tool exchange included: it runs
    // when the child has no history it can rely on (fresh, replaced, or a diverged
    // transcript), and there the calls are the only record that anything ran.
    const prompt =
      this.#sent.length > 0 && append
        ? appendPrompt(rest.slice(this.#sent.length))
        : flattenTranscript(rest);

    const queue = new AsyncQueue();
    const indices = new Map();
    let nextIndex = 0;
    let usage;
    /**
     * The worker's `stop_reason`, when it named one.
     *
     * `max_tokens` means the turn was cut off by a ceiling. It outranks "there were tool calls":
     * the harness drops tool-call blocks on `max-tokens` and only on `max-tokens` (`dsh-llm`,
     * `AssistantStreamAccumulator`), so reporting anything else let a call the worker stopped
     * mid-arguments be treated as complete and run.
     */
    let stopReason;
    /** Reply text withheld until it is known not to be a service notice. */
    let noticeProbe = '';
    let released = false;
    /** Whether any reply text has been seen, held or emitted. */
    let textSeen = false;
    /** Whether any reasoning reached the caller. */
    let reasoningSeen = false;
    /** Whether a recovered tool call was emitted. */
    let sawCall = false;
    /** Whether any text delta arrived, held or not. */
    let sawDelta = false;
    /**
     * Text held because it may be — or already is — the model's own call syntax.
     *
     * The model writes calls as prose, so the tail of every chunk is ambiguous: a
     * reply that will end in markup looks like ordinary words until the marker
     * arrives. Text is therefore held back by the marker's length and released as
     * soon as the next characters rule a call out.
     */
    let pendingText = '';
    let heldText = '';
    let holding = false;
    /** Reasoning gets the same marker guard; nothing is recovered from it. */
    let pendingReasoning = '';
    /** A reasoning block that has opened and not yet closed; see {@link acceptReasoning}. */
    let heldReasoning = '';
    let holdingReasoning = false;
    /**
     * What an unrecoverable call block threw away, if anything.
     *
     * The block itself must not reach the user — that is the whole point of the guard — but
     * discarding it silently makes the turn indistinguishable from a runtime that produced
     * nothing at all. That was the actual behaviour: the turn ended with "the runtime
     * finished the turn without producing any content", which blames the worker for a
     * decision this file made, and leaves no way to tell a stuck model from a stuck plugin.
     * Keeping the size and the first tag lets the empty-turn error say what happened.
     */
    let discarded = undefined;

    // The runtime's block indices address a different numbering than the
    // harness's, and a single turn can interleave reasoning and text blocks; a
    // stable allocation per (worker index, kind) is what keeps deltas landing in
    // the block they started in.
    const indexFor = (workerIndex, kind) => {
      const mapKey = `${String(workerIndex)}:${kind}`;
      const present = indices.get(mapKey);
      if (present !== undefined) return present;
      const allocated = nextIndex;
      nextIndex += 1;
      indices.set(mapKey, allocated);
      return allocated;
    };

    /** Push text the caller may see, once the service-notice window has passed. */
    const emitText = (text, workerIndex) => {
      if (text.length === 0) return;
      textSeen = true;
      if (released) {
        queue.push({ type: 'text-delta', index: indexFor(workerIndex, 'text'), text });
        return;
      }
      noticeProbe += text;
      if (couldBeServiceNotice(noticeProbe)) return;
      released = true;
      const flush = noticeProbe;
      noticeProbe = '';
      queue.push({ type: 'text-delta', index: indexFor(workerIndex, 'text'), text: flush });
    };

    /** One recovered call, announced the way the harness expects a call. */
    const emitCall = (call) => {
      const index = nextIndex;
      nextIndex += 1;
      const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : `qoder_call_${index}`;
      sawCall = true;
      queue.push({ type: 'block-start', index, blockType: 'tool-call' });
      queue.push({ type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: '' });
      queue.push({ type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments });
      queue.push({
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: call.name, arguments: call.arguments }
      });
    };

    /** Release the safe part of a text delta, holding anything a marker could hide. */
    const acceptText = (delta, workerIndex) => {
      sawDelta = true;
      // Once a marker has been seen the rest of the reply is part of the call
      // syntax, not prose: the model emits it in many small deltas, so every one
      // after the marker has to join the held text. Treating them as fresh text is
      // what let `<｜｜DSML｜｜` be swallowed while ` calls>` reached the screen.
      if (holding) {
        heldText += delta;
        return;
      }
      pendingText += delta;
      if (hasNativeLeak(pendingText)) {
        holding = true;
        heldText = pendingText;
        pendingText = '';
        return;
      }
      // A repetition loop, not prose. Live captures contain runs of five hundred
      // fullwidth bars with no call in them at all — the model repeating one token until
      // it runs out of budget. Holding is what stops half a thousand bars reaching the
      // screen; what happens to them afterwards is decided in `settleText`.
      if (isDegenerate(pendingText)) {
        holding = true;
        heldText = pendingText;
        pendingText = '';
        return;
      }
      const keep = endsWithMarkerPrefix(pendingText) ? MARKER_MAX : 0;
      const release = keep === 0 ? pendingText.length : Math.max(0, pendingText.length - keep);
      if (release === 0) return;
      emitText(pendingText.slice(0, release), workerIndex);
      pendingText = pendingText.slice(release);
    };

    /**
     * Turn whatever was held into calls, and leftover prose into text.
     *
     * Nothing is recovered from a quotation-free turn, and a turn that held nothing
     * costs nothing. When the call syntax could not be parsed the words are kept:
     * swallowing a turn is worse than showing the markup it was written in.
     */
    const settleText = () => {
      if (pendingText.length > 0 && !holding) {
        if (hasNativeLeak(pendingText)) {
          holding = true;
          heldText = pendingText;
          pendingText = '';
        } else if (isDegenerate(pendingText)) {
          holding = true;
          heldText = pendingText;
          pendingText = '';
        } else {
          emitText(pendingText, 0);
          pendingText = '';
          return;
        }
      }
      if (!holding) return;
      const raw = heldText;
      const recovered = parseLeakedCalls(raw);
      const degenerate = recovered.degenerate;
      heldText = '';
      holding = false;
      if (recovered.calls.length === 0) {
        // A repetition loop is not a turn that said nothing — it is a turn that produced
        // nothing usable, and showing the bars would let it look like an answer. Failing
        // is the only outcome a user can act on: the reason names the cause, and the
        // conversation is not poisoned with markup that the next turn would imitate.
        if (degenerate) {
          queue.fail(new Error('qoder: the model degenerated into a repetition loop and produced no answer; retry the turn'));
          return;
        }
        // A block that was call syntax but could not be read.
        //
        // This used to emit `raw` — the block exactly as written, delimiter bars and all.
        // That is what put `<｜｜DSML｜｜ calls>` in front of the user: recovery failing is
        // not rare enough to be an edge case, and the raw block is precisely the text the
        // plugin told the model to write, so showing it reads as the plugin talking to
        // itself. The prose around the block is kept instead, which is what the user can
        // actually read; if the block was nothing but an abandoned opener, no text is
        // emitted at all and the turn reads as empty — a state the host already knows how
        // to retry.
        //
        // A block with no `invoke` in it may still be prose *about* the syntax — a sentence
        // explaining tags — where the words are the answer and are shown as written. The
        // test is where the markup sits, not whether it mentions `invoke`: a reply that
        // opens with a tag is trying to call something and lost its way, while one that
        // mentions a tag halfway through a sentence is talking about it.
        const attempted = /invoke\s+name\s*=/iu.test(raw) || /^[\s\uFF5C|]*</u.test(raw);
        this.#logger?.warn?.('qoder: the model wrote call syntax as text and it could not be recovered');
        if (!attempted) {
          emitText(raw, 0);
          return;
        }
        // Remember what was dropped, so an otherwise-empty turn can explain itself instead
        // of blaming the runtime. The tool name is the useful part: "the model was reaching
        // for `pwsh` and could not finish the block" tells the user what to retry, while
        // "opening tag `invoke`" only restates the syntax they cannot see.
        const wanted = /name\s*=\s*["']?([A-Za-z0-9_.-]+)/u.exec(raw);
        discarded = { size: raw.length, tool: wanted?.[1] };
        if (recovered.rest.length > 0) emitText(recovered.rest, 0);
        return;
      }
      for (const call of recovered.calls) emitCall(call);
      if (recovered.rest.length > 0) emitText(recovered.rest, 0);
    };

    /** Stream reasoning, keeping call markup out of a channel the user reads. */
    const acceptReasoning = (delta, workerIndex) => {
      pendingReasoning += delta;
      // While a block is open, nothing is stripped or released: the whole block is held
      // until it closes. Stripping a half-arrived block is what leaked — see below.
      if (holdingReasoning) {
        heldReasoning += pendingReasoning;
        pendingReasoning = '';
        if (hasUnclosedCallMarkup(heldReasoning) || endsWithMarkerPrefix(heldReasoning)) return;
        const cleaned = stripLeak(heldReasoning);
        heldReasoning = '';
        holdingReasoning = false;
        if (cleaned.length > 0) {
          reasoningSeen = true;
          queue.push({ type: 'reasoning-delta', index: indexFor(workerIndex, 'reasoning'), text: cleaned });
        }
        return;
      }
      if (hasLeak(pendingReasoning)) {
        // Hold rather than strip.
        //
        // This used to run `stripLeak` on `pendingReasoning` and clear it, then carry on.
        // With the whole block in one delta that is correct. Streamed, it is not: the first
        // delta that trips `hasLeak` usually carries only the opening of the block, so the
        // strip deletes the opening and the *rest* of the block arrives afterwards carrying
        // no recognisable open tag — `hasLeak` is false for it, so it is released as
        // ordinary reasoning and the user reads
        // `｜｜invoke name="pwsh">｜｜parameter name="command">Get-Date` in the thinking
        // pane. Measured through the real conversation object, char by char: five of nine
        // shapes leaked. The text channel never had this bug because it holds on
        // `hasNativeLeak` and settles with a parser; reasoning had neither.
        holdingReasoning = true;
        heldReasoning = pendingReasoning;
        pendingReasoning = '';
        return;
      }
      const keep = endsWithMarkerPrefix(pendingReasoning) ? MARKER_MAX : 0;
      const release = keep === 0 ? pendingReasoning.length : Math.max(0, pendingReasoning.length - keep);
      if (release === 0) return;
      reasoningSeen = true;
      queue.push({
        type: 'reasoning-delta',
        index: indexFor(workerIndex, 'reasoning'),
        text: pendingReasoning.slice(0, release)
      });
      pendingReasoning = pendingReasoning.slice(release);
    };

    /**
     * Release a held reasoning block when the turn ends mid-block.
     *
     * A block that never closes — the model stopped, or the turn was cut off — would
     * otherwise be dropped entirely, which loses thinking the user can still read. The
     * markup is stripped here the same way the batch path strips it.
     */
    const settleReasoning = (workerIndex = 0) => {
      if (!holdingReasoning) return;
      const raw = heldReasoning + pendingReasoning;
      heldReasoning = '';
      pendingReasoning = '';
      holdingReasoning = false;
      // Truncate before stripping: a block that never closed survives `stripLeak` on
      // purpose, because for history a half-written form is more likely prose about the
      // syntax than a truncated call. At the end of a turn it is the opposite, and showing
      // it is the leak this whole hold exists to prevent.
      const cleaned = stripLeak(truncateOpenMarkup(raw));
      if (cleaned.length === 0) return;
      reasoningSeen = true;
      queue.push({ type: 'reasoning-delta', index: indexFor(workerIndex, 'reasoning'), text: cleaned });
    };

    /** Whether the turn has already shown the caller something. */
    const delivered = () => textSeen || reasoningSeen || sawCall;

    /**
     * The instant this turn must show a sign of life by.
     *
     * Pushed forward by every frame in {@link onEvent}, and by sending the prompt. A single
     * number rather than a per-frame timeout: what matters is time since the last evidence, and
     * a chain of `setTimeout`s would drift and be harder to follow.
     */
    let deadline = Date.now() + this.#idleTimeoutMs;

    /** Whether this turn has already told the caller it is waiting in the model queue. */
    let queuedAnnounced = false;

    const session = this.#session;
    // Env-gated frame tracing. The worker's frame shapes are undocumented, so
    // every field this driver reads was observed rather than assumed, and the next
    // person to need a field should be able to see the same frames — through the
    // logger, so it lands wherever the host's other diagnostics do.
    const trace = process.env['QODER_FRAME_DUMP'] === '1' ? this.#logger?.debug : undefined;
    const onEvent = (message) => {
      // Every frame is a sign of life. A turn that is thinking hard sends `thinking_delta`s the
      // whole time, so this deadline only ever expires on real silence.
      deadline = Date.now() + this.#idleTimeoutMs;
      trace?.(`qoder frame: ${JSON.stringify(message).slice(0, 1200)}`);
      if (message?.type === 'system' && message.subtype === 'model_queue_status') {
        // The worker parks the request in the vendor's model queue and sends this heartbeat
        // while it waits. Ignoring it is what produced a turn that ran for six minutes with
        // zero chunks: the heartbeat kept pushing `deadline` forward, so the stall guard could
        // never fire, and the frame's own account of the wait was discarded.
        const queueCount = Number(message.queue_count);
        const waitMs = Number(message.wait_time_ms);
        // `queue_wait_elapsed_ms` is the figure that matters for the budget: it is how long
        // *this* turn has been waiting, which is what the caller experiences. `wait_time_ms` is
        // the service's own estimate of the remaining wait and includes queue churn.
        const waitedMs = Number(message.queue_wait_elapsed_ms);
        const budgeted = Number.isFinite(waitedMs) ? waitedMs : 0;
        if (!queuedAnnounced) {
          // Say it once. The frame repeats every few seconds, and a notice per frame would
          // bury the answer this turn eventually produces.
          queuedAnnounced = true;
          const sentence = queueSentence({ queueCount, waitMs });
          this.#logger?.info?.(sentence);
          // Pushed directly rather than through `emitText`: that helper feeds the
          // service-notice probe, and this sentence is written by this file, cannot be a
          // notice, and must not be able to terminate the turn as one.
          textSeen = true;
          queue.push({ type: 'text-delta', index: indexFor(0, 'text'), text: `${sentence}\n` });
        }
        if (budgeted >= QUEUE_WAIT_BUDGET_MS) {
          queue.fail(
            noticedFailure(
              `${queueSentence({ queueCount, waitMs })}; this turn waited ${Math.round(budgeted / 60_000)} minutes and was released so it does not hang with no output — retry the turn`,
              'timeout'
            )
          );
        }
        return;
      }
      if (message?.type === 'stream_event') {
        const event = message.event;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            acceptReasoning(delta.thinking, event.index);
          } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            acceptText(delta.text, event.index);
          }
        } else if (event?.type === 'message_delta') {
          // Two facts ride this frame. `usage` was read and `delta.stop_reason` — its sibling —
          // was dropped, which is how a turn cut off by a token ceiling reported itself as a
          // clean finish. Verified against the captured dumps: every `message_delta` carries a
          // `stop_reason` (`end_turn` on healthy turns), so the field is always present and a
          // truncated turn says `max_tokens` in exactly the same place.
          if (event.usage !== undefined) usage = event.usage;
          const reason = event.delta?.stop_reason;
          if (typeof reason === 'string' && reason.length > 0) stopReason = reason;
        }
        return;
      }
      if (message?.type === 'assistant') {
        // A runtime that streamed no deltas still produced a final message;
        // surface it once so the turn is never silently empty. When deltas did
        // arrive the final message repeats them, so re-feeding it would duplicate
        // both prose and any recovered call.
        if (!sawDelta) {
          const text = assistantText(message.message?.content ?? []);
          if (text.length > 0) acceptText(text, 0);
        }
        if (message.error !== undefined && message.error !== null) {
          // The runtime reports a recoverable fault here even on turns that carry
          // a usable answer, and it reports it *after* the deltas have gone out.
          // Failing the queue at that point is what produced the reported
          // "text streaming while an error banner appears": the caller had already
          // seen the answer, and then the turn was declared dead. A turn that has
          // delivered something is finished by its `result` frame instead.
          if (delivered()) {
            this.#logger?.warn?.(`qoder: upstream reported ${String(message.error)} after output was delivered`);
          } else {
            queue.fail(new Error(`qoder: upstream reported ${String(message.error)}`));
          }
        }
        return;
      }
      if (message?.type === 'result') {
        session.endTurn();
        // Whether the turn failed is the frame's own verdict, not the consequence of
        // it carrying a message. The runtime reports a failure in two shapes: a
        // `result` string, and — as it does for a model the account does not have —
        // an `errors` array with no `result` field at all. Reading only `result`
        // made the second shape look like a clean end, so the caller received a
        // turn that finished as `stop` with no text: an empty reply, no error, and
        // nothing in any log. That is indistinguishable from a refusal, which is
        // the worst thing an empty answer can be.
        const failed =
          message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success');
        const detail = failureDetail(message);
        if (failed && !delivered()) {
          queue.fail(new Error(`qoder: ${detail}`));
          return;
        }
        if (failed) {
          this.#logger?.warn?.(`qoder: turn reported an error after output was delivered: ${detail.slice(0, 200)}`);
        }
        // Anything still held is genuine content that never diverged from a marker
        // or a notice, so it is released before the turn closes.
        settleText();
        // A reasoning block the model never closed is released here too. Without this the
        // hold would swallow the tail of every turn that ends mid-block — the block is
        // dropped rather than shown, which is the opposite failure from the leak the hold
        // was added for.
        settleReasoning();
        if (!released) {
          const notice = serviceNotice(noticeProbe);
          if (notice !== undefined) {
            queue.fail(noticedFailure(`qoder: ${noticeProbe.trim()}`, notice.kind));
            return;
          }
          if (noticeProbe.length > 0) emitText(noticeProbe, 0);
          released = true;
          noticeProbe = '';
        }
        // Only a turn with real counts gets a usage chunk; see {@link turnUsage}.
        const reported = turnUsage(usage);
        if (Object.keys(reported).length > 0) queue.push({ type: 'usage', usage: reported });
        // The `failed` branch above covers a frame that says so. This covers the other half:
        // a frame that claims success while nothing came out of the turn. There is no wire
        // evidence to act on — no error, no timeout — so the decision has to be made here or
        // not at all. Finished as `stop`, an empty turn is a blank answer the caller cannot
        // act on, and the same indistinguishability from a refusal the comment above names.
        if (!delivered()) {
          // Name the real cause. Two different failures end here, and reporting both as
          // "the runtime produced nothing" sends the user to the wrong place: one is a
          // worker that answered with nothing, the other is a model that wrote call markup
          // this file refused to show. The second is retryable in a way the first is not.
          const reason =
            discarded === undefined
              ? 'qoder: the runtime finished the turn without producing any content'
              : `qoder: the model wrote call syntax as text and none of it could be recovered, so the turn was discarded to keep the markup off the screen (${discarded.size} characters${discarded.tool === undefined ? '' : `, reaching for \`${discarded.tool}\``}); retry the turn`;
          this.#logger?.warn?.(reason);
          queue.fail(emptyTurn(reason));
          return;
        }
        // A cut-off turn is not a finished one, and it outranks "there were tool calls": a call
        // the worker stopped mid-arguments would otherwise be reported as complete and run.
        queue.push({
          type: 'finish',
          reason: { kind: stopReason === 'max_tokens' ? 'max-tokens' : sawCall ? 'tool-calls' : 'stop' }
        });
        queue.close();
      }
    };

    session.onEvent = onEvent;
    session.onError = (error) => queue.fail(error);

    // The stall guard. Checked on a timer rather than per frame because the case it exists for
    // is precisely the one where no frame arrives to check it on.
    const stallTimer = setInterval(() => {
      if (queue.closed) return;
      if (Date.now() < deadline) return;
      // The worker is still alive and may recover, so it is interrupted rather than killed: a
      // killed child loses the conversation, while an interrupted one can service the retry.
      void session.interrupt();
      queue.fail(
        noticedFailure(`qoder: the worker sent nothing for ${this.#idleTimeoutMs}ms`, 'timeout')
      );
    }, Math.min(this.#idleTimeoutMs, 5_000));
    stallTimer.unref?.();

    const signal = options.signal;
    const onAbort = () => {
      void session.interrupt();
      queue.fail(cancellation('qoder: the request was cancelled'));
    };
    if (signal !== undefined && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });

    // Register how this turn ends, so {@link close} can end it while it is in flight. Without
    // this the child is killed and the queue below is never closed, which leaves the consumer
    // waiting for an event the dead child can no longer send.
    this.#endTurn = (error) => queue.fail(error);

    let completed = false;
    try {
      // A turn whose caller is already gone must not be sent at all. Failing the
      // queue alone was not enough: the prompt below still went out first, so a
      // cancelled turn spent the account's credit and left the child's history one
      // exchange longer than this class believed it to be.
      if (signal?.aborted === true) throw cancellation('qoder: the request was cancelled before it started');
      await session.send(prompt);
      while (true) {
        const result = await queue.next();
        if (result.done === true) {
          completed = true;
          return;
        }
        yield result.value;
      }
    } finally {
      clearInterval(stallTimer);
      session.onEvent = () => {};
      session.onError = () => {};
      session.endTurn();
      this.#endTurn = undefined;
      signal?.removeEventListener?.('abort', onAbort);
      // The child's history now ends with this exchange, so recording what was
      // sent is what lets the next turn recognize a straight append. Only a turn
      // that ran to completion counts: an aborted or failed turn left the child
      // somewhere this list does not describe, and the pool closes it.
      if (completed) this.#sent = rest.map(messageFingerprint);
      else this.#sent.length = 0;
    }
  }

  /**
   * Terminate the child process and end any turn still in flight.
   *
   * The turn has to be ended explicitly. `#session.close()` kills the child, and a killed
   * child sends no further event — so without this the streaming generator would sit on a
   * queue waiting for an event that cannot arrive. The reason names the cause so a caller can
   * tell "the conversation was closed underneath me" from "the model failed".
   */
  async close() {
    this.#closed = true;
    this.#endTurn?.(cancellation('qoder: the conversation was closed before the turn finished'));
    this.#endTurn = undefined;
    await this.#session.close();
  }
}

/**
 * The human-readable reason inside a failed `result` frame.
 *
 * Three shapes exist in the wild and only one of them is `result`:
 *
 *   `result: "..."`                       a plain message
 *   `errors: ["...", "..."]`              what a rejected model produces
 *   neither                               a bare `is_error: true`
 *
 * The middle one is why this exists. Preferring `result` alone reduced a real
 * failure to the empty string, and the driver's own guard — "an error with no
 * message is not an error" — turned it into a successful, empty turn.
 *
 * @param {object} message
 * @returns {string}
 */
function failureDetail(message) {
  if (typeof message.result === 'string' && message.result.trim().length > 0) return message.result.slice(0, 400);
  if (Array.isArray(message.errors) && message.errors.length > 0) {
    const joined = message.errors
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .join('; ');
    if (joined.length > 0) return joined.slice(0, 400);
  }
  if (typeof message.stop_reason === 'string' && message.stop_reason.length > 0) {
    return `the turn failed (${message.subtype ?? 'error'}, stop_reason ${message.stop_reason})`;
  }
  return `the turn failed (${typeof message.subtype === 'string' ? message.subtype : 'error'})`;
}

/**
 * The error a cancelled turn reports.
 *
 * Carries both conventions, because the two drivers serve the same host and a host can only
 * key on one of them:
 *
 * - `name = 'AbortError'` — what the harness and every HTTP client already agree means "the
 *   caller stopped this", and what `test/qoder-cancel.mjs` asserts.
 * - `kind = 'cancelled'` — the shape this repo documents for the other driver, asserted in
 *   `test/cancellation.mjs` (`failure?.kind === 'cancelled'`).
 *
 * Setting only the name, which is what this used to do, meant a host keying on `kind` could
 * not tell a Qoder cancellation from an unclassified fault while the identical WorkBuddy event
 * read as `cancelled`. Neither shape replaces the other: `kind` is what the retry logic reads,
 * `name` is what the error banner and the HTTP-shaped helpers read.
 *
 * @param {string} message
 * @returns {Error}
 */
function cancellation(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  error.kind = 'cancelled';
  return error;
}

/** Read the text out of an assistant message's content blocks. */
function assistantText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * The harness usage record for one turn, or an empty record.
 *
 * Qoder's worker reports every token count as zero — measured on a real turn, in
 * `message_start`, `assistant`, `message_delta`, and `result` alike — so emitting
 * the zeros verbatim would tell the harness that a turn carrying a full context
 * consumed nothing. That is worse than saying nothing: context accounting reads
 * such a turn as empty. Only counts the upstream actually reports survive.
 *
 * The per-turn credit cost the worker does report (`message_delta.usage.credits`)
 * is deliberately not folded in here: it is not a token count, the harness has no
 * field for it, and inventing one would break the harness's own arithmetic.
 *
 * @param {object | undefined} usage
 * @returns {Record<string, number>}
 */
function turnUsage(usage) {
  if (usage === null || typeof usage !== 'object') return {};
  const counts = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens
  };
  const out = {};
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}
