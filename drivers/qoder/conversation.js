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
  MARKER_MAX,
  parseLeakedCalls,
  stripLeak
} from '../../lib/dsml.js';
import { flattenConversation, isStraightAppend, messageFingerprint, splitSystem } from '../../lib/messages.js';

/**
 * The runtime announces a saturated queue as an ordinary answer, so the opening
 * characters of a reply cannot be forwarded immediately: a notice has to become an
 * error instead of appearing as the model's own words. Both strings are the
 * runtime's, matched whole and lower-cased.
 */
const SERVICE_NOTICES = new Set([
  'the model is busy and could not complete the request. please try again later.',
  'queuing failed. try again later or enter /model to switch models.'
]);

/**
 * Whether text is still on course to be a service notice.
 *
 * Used as a hold predicate: while it holds, nothing is emitted, because a notice
 * that has not diverged from a known notice yet may still turn into one.
 *
 * @param {string} held
 * @returns {boolean}
 */
function couldBeServiceNotice(held) {
  const lowered = held.trimStart().toLowerCase();
  for (const notice of SERVICE_NOTICES) {
    if (notice.startsWith(lowered)) return true;
  }
  return false;
}

/**
 * Whether text is exactly a service notice.
 *
 * @param {string} held
 * @returns {boolean}
 */
function isServiceNotice(held) {
  return SERVICE_NOTICES.has(held.trim().toLowerCase());
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
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="TOOL_NAME">',
    '<｜｜DSML｜｜ parameter name="PARAMETER_NAME" string="true">VALUE</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>',
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
  #logger;
  #closed = false;
  /** Fingerprints of the projected messages the child's history now reflects. */
  #sent = [];
  /** The system prompt `initialize` was last given. */
  #systemPrompt = '';

  /**
   * @param {object} options
   * @param {string} options.runtimePath - the app's own worker runtime entry.
   * @param {string} [options.sdkVersion]
   * @param {string} [options.cwd]
   * @param {() => Promise<object>} options.resolveCredential
   * @param {{debug?: Function, info?: Function, warn?: Function}} [options.logger]
   */
  constructor(options) {
    this.#logger = options.logger;
    this.#session = new QoderSession({
      runtimePath: options.runtimePath,
      sdkVersion: options.sdkVersion,
      cwd: options.cwd ?? process.cwd(),
      resolveCredential: options.resolveCredential,
      logger: options.logger
    });
  }

  /** The runtime's own model listing, read over this conversation's transport. */
  async listModels() {
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

    const prompt = this.#sent.length > 0 && append ? rest[rest.length - 1].text : flattenConversation(rest);

    const queue = new AsyncQueue();
    const indices = new Map();
    let nextIndex = 0;
    let usage;
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
        } else {
          emitText(pendingText, 0);
          pendingText = '';
          return;
        }
      }
      if (!holding) return;
      const recovered = parseLeakedCalls(heldText);
      heldText = '';
      holding = false;
      if (recovered.calls.length === 0) {
        this.#logger?.warn?.('qoder: the model wrote call syntax as text and it could not be recovered');
        emitText(recovered.rest, 0);
        return;
      }
      for (const call of recovered.calls) emitCall(call);
      if (recovered.rest.length > 0) emitText(recovered.rest, 0);
    };

    /** Stream reasoning, keeping call markup out of a channel the user reads. */
    const acceptReasoning = (delta, workerIndex) => {
      pendingReasoning += delta;
      if (hasLeak(pendingReasoning)) {
        const cleaned = stripLeak(pendingReasoning);
        pendingReasoning = '';
        if (cleaned.length > 0) {
          reasoningSeen = true;
          queue.push({ type: 'reasoning-delta', index: indexFor(workerIndex, 'reasoning'), text: cleaned });
        }
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

    /** Whether the turn has already shown the caller something. */
    const delivered = () => textSeen || reasoningSeen || sawCall;

    const session = this.#session;
    // Env-gated frame tracing. The worker's frame shapes are undocumented, so
    // every field this driver reads was observed rather than assumed, and the next
    // person to need a field should be able to see the same frames — through the
    // logger, so it lands wherever the host's other diagnostics do.
    const trace = process.env['QODER_FRAME_DUMP'] === '1' ? this.#logger?.debug : undefined;
    const onEvent = (message) => {
      trace?.(`qoder frame: ${JSON.stringify(message).slice(0, 1200)}`);
      if (message?.type === 'stream_event') {
        const event = message.event;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            acceptReasoning(delta.thinking, event.index);
          } else if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            acceptText(delta.text, event.index);
          }
        } else if (event?.type === 'message_delta' && event.usage !== undefined) {
          usage = event.usage;
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
        if (!released) {
          if (isServiceNotice(noticeProbe)) {
            queue.fail(new Error(`qoder: ${noticeProbe.trim()}`));
            return;
          }
          if (noticeProbe.length > 0) emitText(noticeProbe, 0);
          released = true;
          noticeProbe = '';
        }
        // Only a turn with real counts gets a usage chunk; see {@link turnUsage}.
        const reported = turnUsage(usage);
        if (Object.keys(reported).length > 0) queue.push({ type: 'usage', usage: reported });
        queue.push({ type: 'finish', reason: { kind: sawCall ? 'tool-calls' : 'stop' } });
        queue.close();
      }
    };

    session.onEvent = onEvent;
    session.onError = (error) => queue.fail(error);

    const signal = options.signal;
    const onAbort = () => {
      void session.interrupt();
      queue.fail(cancellation('qoder: the request was cancelled'));
    };
    if (signal !== undefined && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });

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
      session.onEvent = () => {};
      session.onError = () => {};
      session.endTurn();
      signal?.removeEventListener?.('abort', onAbort);
      // The child's history now ends with this exchange, so recording what was
      // sent is what lets the next turn recognize a straight append. Only a turn
      // that ran to completion counts: an aborted or failed turn left the child
      // somewhere this list does not describe, and the pool closes it.
      if (completed) this.#sent = rest.map(messageFingerprint);
      else this.#sent.length = 0;
    }
  }

  /** Terminate the child process. */
  async close() {
    this.#closed = true;
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
 * Named `AbortError` on purpose: that is what the harness and every HTTP client
 * already agree means "the caller stopped this", and it is what keeps a cancelled
 * turn from being reported as, or retried like, an upstream failure.
 *
 * @param {string} message
 * @returns {Error}
 */
function cancellation(message) {
  const error = new Error(message);
  error.name = 'AbortError';
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
