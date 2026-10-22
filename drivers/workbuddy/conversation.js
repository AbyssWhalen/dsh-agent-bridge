/**
 * One WorkBuddy conversation.
 *
 * WorkBuddy is the one vendor here that is **stateless** from this plugin's side:
 * every request carries the whole conversation, so there is no upstream session to
 * keep in sync and nothing to reconcile. Each call is a fresh POST, which makes
 * this driver structurally different from the Qoder one — and is exactly the
 * difference the host layer was built to absorb.
 *
 * ## Parsing the stream
 *
 * The upstream answers with OpenAI-compatible SSE. The deltas (`choices[0].delta`)
 * carry `content` and, on reasoning models, `reasoning_content`; the terminator is
 * `data: [DONE]`. Usage rides the final chunk when the upstream sends it, and is
 * read when present rather than required — a stream that ends without it still
 * finishes cleanly, because a missing token count is not a failed turn.
 *
 * @module dsh-agent-bridge/drivers/workbuddy/conversation
 */
import {
  endsWithMarkerPrefix,
  hasLeak,
  hasNativeLeak,
  isDegenerate,
  MARKER_MAX,
  parseLeakedCalls,
  stripLeak
} from '../../lib/dsml.js';
import { assistantProse, flattenConversation, messageText, splitSystem, toolCallsOf } from '../../lib/messages.js';
import { UpstreamFailure } from './upstream.js';
import { emptyTurn, noticedFailure } from '../../lib/failure.js';

/** How long a stream may go without a frame before it is considered stalled. */
export const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * An async queue with a terminal state.
 *
 * Same contract as the other drivers': `push` never blocks, `fail` records a
 * terminal error, `close` ends iteration, and a late consumer still drains what
 * was already queued.
 */
class AsyncQueue {
  #items = [];
  #waiters = [];
  #failure;
  #closed = false;

  push(item) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  fail(error) {
    if (this.#closed) return;
    this.#failure = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  get closed() {
    return this.#closed;
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#failure !== undefined) return Promise.reject(this.#failure);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }
}

/** One conversation against the WorkBuddy upstream. */
export class WorkBuddyConversation {
  #client;
  #resolveCredential;
  #logger;
  #idleTimeoutMs;
  #closed = false;

  /**
   * @param {object} options
   * @param {import('./upstream.js').UpstreamClient} options.client
   * @param {() => Promise<object>} options.resolveCredential
   * @param {{debug?: Function, warn?: Function}} [options.logger]
   * @param {number} [options.idleTimeoutMs] - override for {@link STREAM_IDLE_TIMEOUT_MS};
   *   exists so a test can reach the stall guard in milliseconds instead of five minutes. No
   *   caller in this plugin sets it.
   */
  constructor(options) {
    this.#client = options.client;
    this.#resolveCredential = options.resolveCredential;
    this.#logger = options.logger;
    this.#idleTimeoutMs =
      Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs > 0
        ? options.idleTimeoutMs
        : STREAM_IDLE_TIMEOUT_MS;
  }

  /** Stateless, so a conversation is usable the moment it exists. */
  get ready() {
    return !this.#closed;
  }

  /**
   * Run one turn.
   *
   * @param {{role: string, text: string}[]} messages
   * @param {{model?: string, effort?: string, signal?: AbortSignal}} options
   * @returns {AsyncIterable<object>} harness stream chunks.
   */
  async *send(messages, options = {}) {
    if (this.#closed) throw new Error('workbuddy: conversation is closed');
    // A turn whose caller is already gone must not be sent at all. Checking only inside the
    // stream means the request went out, the account was charged, and the model answered
    // something nobody will read — which is the lesson the Qoder driver learned from a live
    // capture, where a cancelled turn also left the child's history one exchange longer than
    // the class believed. This driver has no history to corrupt, but it has the same cost.
    if (options.signal?.aborted === true) {
      throw new UpstreamFailure('cancelled', 0, 'the caller cancelled the request before it started');
    }
    const credential = await this.#resolveCredential();
    const list = Array.isArray(messages) ? messages : [];
    const region = this.#client.region;
    const tools = toWireTools(options.tools);
    const effort = wireEffortLabel(options.effort);
    const maxTokens =
      Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : undefined;

    const body = {
      model: options.model,
      messages: toWireMessages(list, region),
      stream: true,
      // A ceiling the caller set is a ceiling the upstream should see. Measured: the harness
      // sends `maxTokens: 64` on a session-title turn and `128000` on an ordinary one, and until
      // now neither reached the wire, so "at most 64 tokens" was advice the model never got.
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      // Without this the model has no tool channel and answers with `<tool_call>`
      // prose instead — which is what made this vendor unusable as a coding agent.
      ...(tools === undefined ? {} : { tools, tool_choice: 'auto' })
    };

    const response = await this.#client.chatStream(credential, body, options.signal);
    yield* this.#translate(response, options.signal);
  }

  /**
   * Convert the upstream's SSE body into harness chunks.
   *
   * @param {Response} response
   * @param {AbortSignal | undefined} signal
   * @returns {AsyncIterable<object>}
   */
  async *#translate(response, signal) {
    const queue = new AsyncQueue();
    const textIndex = 0;
    const reasoningIndex = 1;
    // Tool blocks get their own indices, allocated on first sight of a call.
    let nextBlockIndex = 2;
    const openCalls = new Map();
    let sawUsage;
    let sawToolCall = false;
    /**
     * The upstream's `finish_reason`, when it named one.
     *
     * `length` means the turn was cut off by a token ceiling. Verified from a live request
     * (`max_tokens: 20` → `finish_reason: "length"`), because the field is absent from the
     * frame dumps: those capture the Qoder worker's stdout and WorkBuddy is an HTTP stream.
     *
     * Ignoring it made a cut-off answer look complete, and — worse — made a cut-off tool call
     * look runnable. The harness drops tool-call blocks on `max-tokens` and only on `max-tokens`
     * (`dsh-llm`, `AssistantStreamAccumulator`), so reporting `stop` skipped that guard and a
     * half-written `{"command":"Get-Chil` reached the tool as if the model had finished typing.
     */
    let sawFinishReason;
    let stalled = false;
    let deadline = Date.now() + this.#idleTimeoutMs;

    /**
     * Whether the caller has already been given something in this turn.
     *
     * The reason this is tracked at all: an upstream error frame can arrive *after* the
     * answer has gone out. Failing the turn at that point throws away an answer the user was
     * already reading, which is the pathology the Qoder driver fixed after seeing it live —
     * "text streaming while an error banner appears". A turn that has delivered something is
     * finished by the end of its stream instead, and the fault is only logged. One that
     * delivered nothing really did fail, and saying so is the only useful outcome.
     */
    const delivered = () => sawToolCall || sawText || sawReasoning;

    /**
     * Close every call that was announced but not finished.
     *
     * Idempotent, and it has to be called on every way out of the turn, not only the tidy
     * ones. Every `block-start` the driver pushes has already been recorded by the host, so a
     * `block-start` with no matching `block-end` is a broken history entry — the shape that
     * produced `11148 tool calls and tool results do not match` in a live capture. A call cut
     * off mid-arguments is still worth closing: the harness pairs it, the tool rejects the
     * partial arguments, and the failure is legible.
     *
     * Defined before the idle timer because the timer is one of the ways out.
     */
    const closeCalls = () => {
      for (const call of openCalls.values()) {
        queue.push({
          type: 'block-end',
          index: call.index,
          block: { type: 'tool-call', id: call.id, ...(call.name === undefined ? {} : { name: call.name }), arguments: call.arguments }
        });
      }
      openCalls.clear();
    };

    // An idle *timeout*, not an interval: a long answer that keeps producing
    // frames must never be killed by the clock. The old version fired once from
    // stream start regardless of traffic, so a slow but healthy turn died at the
    // mark with "produced nothing", which was a lie.
    const timer = setInterval(() => {
      if (queue.closed) return;
      if (Date.now() < deadline) return;
      stalled = true;
      closeCalls();
      // Marked, not merely described. A bare `Error` carries no kind, so this reached the
      // harness as `INTERNAL` — which is not in the default retryable set — and a connection
      // that died mid-stream ended the turn for good while a 429 one second later would have
      // been retried. `timeout` rather than `transport`: the response arrived and then stopped,
      // and the session log should be able to tell those apart.
      queue.fail(
        noticedFailure(`workbuddy: the stream produced nothing for ${this.#idleTimeoutMs}ms`, 'timeout')
      );
    }, Math.min(this.#idleTimeoutMs, 5_000));
    timer.unref?.();

    // Text is held back by a marker's length so a call that arrives as text can
    // still be recognized. Only the tail is at risk: a full marker is detected on
    // sight, and the last few characters are held until they either disambiguate
    // or prove to be an ordinary '<'.
    let pendingText = '';
    let heldText = '';
    let holding = false;
    /** Whether anything has been handed to the caller yet; see {@link delivered}. */
    let sawText = false;
    let sawReasoning = false;

    // The reasoning channel gets the same treatment. It is shown while the turn
    // streams, so markup written there is just as visible — and it is replayed as
    // history, so it seeds the same imitation. Nothing is recovered from it: the
    // real call arrives on its own channel.
    let pendingReasoning = '';

    const flushText = (part) => {
      if (part.length === 0) return;
      sawText = true;
      queue.push({ type: 'text-delta', index: textIndex, text: part });
    };

    /** Stream reasoning while keeping a possible marker out of the visible part. */
    const acceptReasoning = (delta) => {
      pendingReasoning += delta;
      if (hasLeak(pendingReasoning)) {
        // Hold until the block is complete, then drop it wholesale.
        if (/\[tool call:[^\]]*\]/u.test(pendingReasoning) || /<\/[\uFF5C|]{2}\s*DSML[\s\S]*?$/u.test(pendingReasoning)) {
          const cleaned = stripLeak(pendingReasoning);
          if (cleaned.length > 0) {
            sawReasoning = true;
            queue.push({ type: 'reasoning-delta', index: reasoningIndex, text: cleaned });
          }
          pendingReasoning = '';
        }
        return;
      }
      const keep = endsWithMarkerPrefix(pendingReasoning) || /\[tool call:?[^\]]*$/u.test(pendingReasoning)
        ? MARKER_MAX * 2
        : 0;
      const release = keep === 0 ? pendingReasoning.length : Math.max(0, pendingReasoning.length - keep);
      if (release === 0) return;
      sawReasoning = true;
      queue.push({ type: 'reasoning-delta', index: reasoningIndex, text: pendingReasoning.slice(0, release) });
      pendingReasoning = pendingReasoning.slice(release);
    };

    /** Release reasoned text that was held back, then drop any markup in it. */
    const settleReasoning = () => {
      if (pendingReasoning.length === 0) return;
      const cleaned = hasLeak(pendingReasoning) ? stripLeak(pendingReasoning) : pendingReasoning;
      if (cleaned.length > 0) {
        sawReasoning = true;
        queue.push({ type: 'reasoning-delta', index: reasoningIndex, text: cleaned });
      }
      pendingReasoning = '';
    };

    const acceptText = (delta) => {
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
      // A repetition loop, not prose. Live captures contain runs of five hundred fullwidth
      // bars with no call in them at all — the model repeating one token until it runs out
      // of budget. A run of bars is not a marker, so without this check it takes the release
      // path below and the whole wall renders: measured 500 bars of text and no error on
      // this driver while the Qoder one failed the turn with a named reason. That asymmetry
      // was the bug — the guard existed on one driver and not the other.
      if (isDegenerate(pendingText)) {
        holding = true;
        heldText = pendingText;
        pendingText = '';
        return;
      }
      // Release everything but a possible marker prefix.
      const keep = endsWithMarkerPrefix(pendingText) ? MARKER_MAX : 0;
      const release = keep === 0 ? pendingText.length : Math.max(0, pendingText.length - keep);
      if (release === 0) return;
      flushText(pendingText.slice(0, release));
      pendingText = pendingText.slice(release);
    };

    /**
     * Turn whatever was held into calls, and any leftover prose into text.
     *
     * This is the recovery path: a model that writes its *native* call syntax into
     * the content stream still gets its intent honoured, instead of the user
     * seeing raw markup where an answer should be.
     *
     * Only the native form is recovered. The bracketed `[tool call: …]` form is
     * this plugin's own rendering, and a model can also be *quoting* it — a user
     * who asks "print that text verbatim" must get the text, not a fabricated call
     * to a tool that was never invoked. So the bracketed form is only cleaned out
     * of replayed history, where it demonstrably teaches imitation, and never
     * turned into a call here.
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
          flushText(pendingText);
          pendingText = '';
          return;
        }
      }
      if (!holding) return;
      const raw = heldText;
      const native = /DSML/u.test(raw);
      const recovered = native
        ? parseLeakedCalls(raw)
        : { calls: [], rest: stripLeak(raw), leaked: true };
      // Read off the raw held text, not off the recovered block. A wall of bars is not call
      // syntax at all, so the non-native branch above never asks the parser for a verdict —
      // taking `degenerate` from the parse result would leave it `undefined` and let exactly
      // the text this check exists to stop through. Measured: 500 bars rendered again.
      const degenerate = recovered.degenerate === true || isDegenerate(raw);
      heldText = '';
      holding = false;
      if (recovered.calls.length === 0) {
        // A repetition loop is not a turn that said nothing — it is a turn that produced
        // nothing usable, and showing the bars would let it look like an answer. Failing is
        // the only outcome a user can act on: the reason names the cause, and the
        // conversation is not poisoned with markup the next turn would imitate.
        if (degenerate) {
          queue.fail(
            new Error('workbuddy: the model degenerated into a repetition loop and produced no answer; retry the turn')
          );
          return;
        }
        if (native) {
          // Nothing parseable: keep the words rather than swallow the turn.
          this.#logger?.warn?.(
            'workbuddy: the model wrote its native call syntax as text, and it could not be recovered'
          );
        }
        flushText(recovered.rest);
        return;
      }
      this.#logger?.warn?.(
        `workbuddy: recovered ${recovered.calls.length} tool call(s) the model wrote as text instead of calling`
      );
      for (const call of recovered.calls) {
        const index = nextBlockIndex;
        nextBlockIndex += 1;
        sawToolCall = true;
        const id = `call_recovered_${index}`;
        queue.push({ type: 'block-start', index, blockType: 'tool-call' });
        queue.push({ type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: '' });
        queue.push({ type: 'tool-call-delta', index, id, argumentsDelta: call.arguments });
        queue.push({ type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } });
      }
      if (recovered.rest.length > 0) flushText(recovered.rest);
    };

    const pump = (async () => {
      try {
        if (response.body === null || response.body === undefined) {
          throw new Error('workbuddy: the upstream response carried no body');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let boundary = buffer.indexOf('\n');
          while (boundary >= 0) {
            const line = buffer.slice(0, boundary).replace(/\r$/u, '');
            buffer = buffer.slice(boundary + 1);
            if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (payload === '[DONE]') {
                settleReasoning();
                settleText();
                closeCalls();
                queue.close();
                return;
              }
              if (payload.length > 0) {
                const parsed = safeParse(payload);
                if (parsed !== undefined) {
                  deadline = Date.now() + this.#idleTimeoutMs;
                  const usage = readUsage(parsed);
                  if (usage !== undefined) sawUsage = usage;
                  const cut = readFinishReason(parsed);
                  if (cut !== undefined) sawFinishReason = cut;
                  for (const delta of readDeltas(parsed)) {
                    if (delta.text !== undefined) {
                      acceptText(delta.text);
                    }
                    if (delta.reasoning !== undefined) {
                      acceptReasoning(delta.reasoning);
                    }
                    for (const call of delta.toolCalls ?? []) {
                      let open = openCalls.get(call.index);
                      if (open === undefined) {
                        open = {
                          index: nextBlockIndex,
                          id: call.id ?? `call_${call.index}`,
                          name: call.name,
                          arguments: ''
                        };
                        nextBlockIndex += 1;
                        sawToolCall = true;
                        openCalls.set(call.index, open);
                        queue.push({ type: 'block-start', index: open.index, blockType: 'tool-call' });
                      } else {
                        if (call.id !== undefined) open.id = call.id;
                        if (call.name !== undefined) open.name = call.name;
                      }
                      // The id and the name must reach the harness before the
                      // arguments do, so every fragment is announced first.
                      queue.push({
                        type: 'tool-call-delta',
                        index: open.index,
                        id: open.id,
                        ...(open.name === undefined ? {} : { name: open.name }),
                        argumentsDelta: ''
                      });
                      if (call.argumentsDelta !== '') {
                        open.arguments += call.argumentsDelta;
                        queue.push({ type: 'tool-call-delta', index: open.index, id: open.id, argumentsDelta: call.argumentsDelta });
                      }
                    }
                  }
                  const failure = readError(parsed);
                  if (failure !== undefined) {
                    closeCalls();
                    // An error frame can arrive after the answer has gone out. Failing here
                    // would throw away an answer the user was already reading — the same
                    // pathology the Qoder driver fixed from a live capture ("text streaming
                    // while an error banner appears"). With nothing delivered, the turn really
                    // did fail and the reason is the only useful output.
                    if (delivered()) {
                      this.#logger?.warn?.(
                        `workbuddy: the upstream reported an error after output was delivered: ${failure}`
                      );
                      queue.close();
                      return;
                    }
                    queue.fail(new Error(`workbuddy: the upstream reported an error: ${failure}`));
                    return;
                  }
                }
              }
            }
            boundary = buffer.indexOf('\n');
          }
        }
        // The body ended without a `[DONE]` sentinel. That is not treated as a
        // failure: some deployments close the connection instead, and the deltas
        // already received are the answer.
        settleReasoning();
        settleText();
        closeCalls();
        queue.close();
      } catch (error) {
        if (!stalled) {
          // A cancellation that lands mid-stream arrives here rather than at the
          // request, because the response was already open. It is reported the
          // same way the request path reports it, so one cancellation always looks
          // like one thing.
          const cancellation = signal?.aborted === true;
          // A call announced a moment before the stream died is still open. Closing it here
          // keeps the chunk stream pairable: the host has already recorded the `block-start`,
          // and a call left unpaired is what produced `tool calls and tool results do not
          // match` in a live capture. The partial arguments are the tool's problem, not the
          // history's.
          closeCalls();
          queue.fail(
            cancellation
              ? new UpstreamFailure('cancelled', 0, 'the caller cancelled the request')
              : error instanceof Error
                ? error
                : new Error(String(error))
          );
        }
      }
    })();

    try {
      yield* queue;
      // A stream that ended cleanly having produced nothing is not a clean turn. There is no
      // wire evidence of a fault — no error frame, no timeout — which is exactly why this
      // has to be decided here: reported as a `finish`, the caller sees a blank answer, has
      // no reason to retry, and the turn's credit is gone. An empty reply is also
      // indistinguishable from a refusal, and a refusal the user cannot see is worse than a
      // failure they can read.
      if (!delivered()) {
        throw emptyTurn('workbuddy: the upstream finished the turn without producing any content');
      }
      if (sawUsage !== undefined) yield { type: 'usage', usage: sawUsage };
      // A cut-off turn is not a finished one, and it outranks "there were tool calls": a call
      // the upstream stopped mid-arguments would otherwise be reported as complete and run.
      yield {
        type: 'finish',
        reason: { kind: sawFinishReason === 'length' ? 'max-tokens' : sawToolCall ? 'tool-calls' : 'stop' }
      };
    } finally {
      clearInterval(timer);
      await pump.catch(() => undefined);
    }
  }

  /** Stateless: nothing to release, but the host expects the member. */
  async close() {
    this.#closed = true;
  }
}

/**
 * The `tools` array this wire expects, or `undefined` when there are none.
 *
 * The harness hands adapters `{ name, description, parameters }`; the wire wants
 * the OpenAI `function` envelope. A malformed entry is skipped rather than
 * forwarded, because one bad schema makes the upstream reject the whole request
 * and the failure would look like the model refusing to answer.
 *
 * @param {readonly {name?: string, description?: string, parameters?: unknown}[] | undefined} tools
 * @returns {{type: 'function', function: {name: string, description?: string, parameters?: unknown}}[] | undefined}
 */
export function toWireTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const mapped = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue;
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
    mapped.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description.length > 0 ? { description: tool.description } : {}),
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters })
      }
    });
  }
  return mapped.length === 0 ? undefined : mapped;
}

/**
 * Build the wire message list from the harness's normalized messages.
 *
 * The upstream takes a single flat conversation, so a leading system turn is
 * carried through as a `system` message and the rest is flattened. Once a
 * conversation has more than one system turn — which happens as the harness's own
 * prompt and this plugin's preamble accumulate — the whole history is flattened
 * into one user turn, because two system turns are not expressible on this wire.
 *
 * Assistant tool calls and their `tool` answers are kept structured. Flattening
 * them into prose loses the id that ties a result to its call, and the upstream
 * rejects a `tool` message that answers nothing.
 *
 * ## Why the calls are read twice
 *
 * `toolCalls` is the projection's field, so it is the normal source. But this
 * function is also reached with messages that have not been projected — a caller
 * using `openSession()` directly, a future non-DSH shell — and a raw harness
 * message keeps its calls inside `content` blocks instead.
 *
 * Reading only `toolCalls` made that case catastrophic rather than merely
 * degraded: the missing calls sent this down the text path, where the rendered
 * `[tool call: …]` form was then removed by {@link stripLeak} as if it were
 * leaked markup, leaving an empty message that was dropped entirely. The request
 * reached the upstream with a `tool` result and no call for it to answer, which
 * the upstream refuses (`11148 tool calls and tool results do not match`) — a
 * failure that looks like a broken proxy rather than like a message shape.
 *
 * So the blocks are the fallback, and a turn that carries calls always travels as
 * `tool_calls`.
 *
 * @param {{role: string, text: string, toolCalls?: {id: string, name: string, arguments: string}[], toolCallId?: string, content?: unknown}[]} messages
 * @param {'cn' | 'global'} region
 * @returns {object[]}
 */
export function toWireMessages(messages, region) {
  const { system, rest } = splitSystem(messages);
  const wire = [];
  /** Call ids already sent on this request; a result may only answer one of them. */
  const sentCalls = new Set();
  if (system.length > 0) wire.push({ role: 'system', content: system });
  for (const message of rest) {
    const calls = callsOf(message);
    // An assistant turn that carries real calls must not also carry the rendered
    // `[tool call: …]` form: the model reads its own history and copies that
    // spelling, producing a burst of pseudo-call text beside the real call.
    const text =
      message.role === 'assistant'
        ? stripLeak(calls.length > 0 ? assistantProse(message) : messageText(message))
        : messageText(message);
    if (message.role === 'tool') {
      if (text.length === 0) continue;
      const answering = typeof message.toolCallId === 'string' ? message.toolCallId : '';
      if (answering !== '' && sentCalls.has(answering)) {
        wire.push({ role: 'tool', tool_call_id: answering, content: text });
        continue;
      }
      // A result whose call is not in this request cannot be expressed on this
      // wire: the upstream refuses a `tool` message that answers nothing
      // (`11148`). That shape is reachable — a compaction may keep a result and
      // drop the turn that asked for it — so the words are kept as a user turn
      // instead of being dropped or sent as something invalid. The id stays in the
      // text so the model can still tell two results apart.
      wire.push({
        role: 'user',
        content: answering === '' ? `[tool result]\n${text}` : `[tool result ${answering}]\n${text}`
      });
      continue;
    }
    if (message.role === 'assistant' && calls.length > 0) {
      wire.push({
        role: 'assistant',
        content: text.length === 0 ? null : text,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      });
      for (const call of calls) sentCalls.add(call.id);
      continue;
    }
    if (text.length === 0) continue;
    wire.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  if (wire.length === 0 || (wire.length === 1 && wire[0].role === 'system')) {
    wire.push({ role: 'user', content: flattenConversation(messages) });
  }
  // The upstream demands a leading system turn on the international region; the
  // transport adds one there, so nothing is done about it here.
  void region;
  return wire;
}

/**
 * The tool calls one assistant message carries, however it was built.
 *
 * The projected `toolCalls` field wins when present. Otherwise the raw harness
 * shape is read from `content`, which is what an unprojected caller hands over.
 * See {@link toWireMessages} for what reading only one of them cost.
 *
 * @param {{toolCalls?: {id: string, name: string, arguments: string}[], content?: unknown}} message
 * @returns {{id: string, name: string, arguments: string}[]}
 */
function callsOf(message) {
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return message.toolCalls;
  return toolCallsOf(message.content);
}

/** Parse one SSE payload, or `undefined` when it is not JSON. */
function safeParse(payload) {
  try {
    const parsed = JSON.parse(payload);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The text, reasoning, and tool-call deltas in one upstream chunk.
 *
 * All three are read from every choice because the upstream has been seen to
 * send a reasoning chunk and a content chunk as separate events with the same
 * index. Tool-call fragments are read here too: they used to be dropped on the
 * floor, which is why a turn that called a tool rendered as an empty answer.
 *
 * @param {object} chunk
 * @returns {{text?: string, reasoning?: string, toolCalls?: {index: number, id?: string, name?: string, argumentsDelta: string}[]}[]}
 */
function readDeltas(chunk) {
  if (!Array.isArray(chunk.choices)) return [];
  const deltas = [];
  for (const choice of chunk.choices) {
    if (choice === null || typeof choice !== 'object') continue;
    const delta = choice.delta ?? choice.message;
    if (delta === null || typeof delta !== 'object') continue;
    const text = typeof delta.content === 'string' && delta.content.length > 0 ? delta.content : undefined;
    const reasoning =
      typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' && delta.reasoning.length > 0
          ? delta.reasoning
          : undefined;
    const toolCalls = readToolCalls(delta);
    if (text !== undefined || reasoning !== undefined || toolCalls.length > 0) {
      deltas.push({
        ...(text === undefined ? {} : { text }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(toolCalls.length === 0 ? {} : { toolCalls })
      });
    }
  }
  return deltas;
}

/**
 * The tool-call fragments in one delta.
 *
 * OpenAI-shaped upstreams stream a call as: an opening fragment carrying `id`
 * and `function.name`, then one fragment per slice of the JSON arguments, all
 * tied together by `index`. `argumentsDelta` is always a string so the caller
 * does not have to distinguish "opening fragment" from "argument fragment".
 *
 * @param {object} delta
 * @returns {{index: number, id?: string, name?: string, argumentsDelta: string}[]}
 */
function readToolCalls(delta) {
  const calls = [];
  if (!Array.isArray(delta.tool_calls)) return calls;
  for (const [position, call] of delta.tool_calls.entries()) {
    if (call === null || typeof call !== 'object') continue;
    const index = typeof call.index === 'number' && Number.isFinite(call.index) ? call.index : position;
    const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
    const name = typeof call.function?.name === 'string' && call.function.name.length > 0 ? call.function.name : undefined;
    const args = call.function?.arguments;
    const argumentsDelta = typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args);
    calls.push({ index, ...(id === undefined ? {} : { id }), ...(name === undefined ? {} : { name }), argumentsDelta });
  }
  return calls;
}

/**
 * The upstream's spelling of a reasoning level.
 *
 * The harness says `off`; this upstream says `none`. Measured, not assumed — three samples per
 * spelling on a concrete model:
 *
 *     reasoning_effort: "none" → reasoning_tokens 0, no reasoning_content
 *     reasoning_effort: "off"  → 0 on a model that supports effort, but 35 reasoning tokens
 *                                when the request went out as `model: "auto"`
 *     field omitted            → 35 reasoning tokens
 *
 * `none` is the OpenAI spelling and the only one that held in both routings, so `off` becomes
 * `none` rather than being passed through or dropped. Dropping it — which is what this driver
 * did not do, but what the effort module's comment claimed — leaves thinking on.
 *
 * Everything else passes through unchanged; the upstream rejects an unknown level rather than
 * silently downgrading it, and that loud failure is preferable to guessing here.
 *
 * @param {unknown} effort
 * @returns {string | undefined}
 */
function wireEffortLabel(effort) {
  if (typeof effort !== 'string' || effort.length === 0) return undefined;
  return effort === 'off' ? 'none' : effort;
}

/**
 * The upstream's `finish_reason` from one frame, when it names one.
 *
 * Only `length` carries a meaning this driver acts on: it is the one reason that says the turn
 * was cut short rather than ended. Everything else — `stop`, `content_filter`, and whatever a
 * future version invents — is reported as an ordinary finish, because the session format accepts
 * exactly three kinds (`stop`, `tool-calls`, `max-tokens`) and passing an unknown one through
 * would be rejected outright.
 *
 * @param {object} chunk
 * @returns {string | undefined}
 */
function readFinishReason(chunk) {
  const choices = chunk.choices;
  if (!Array.isArray(choices)) return undefined;
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      return choice.finish_reason;
    }
  }
  return undefined;
}

/**
 * Token usage from one chunk, when the upstream reports it.
 *
 * The upstream's object carries the same facts under several names and one convention that has
 * to be undone. Measured from a live turn, not inferred:
 *
 *     {"prompt_tokens":28,"completion_tokens":21,
 *      "completion_tokens_details":{"reasoning_tokens":18,"cached_tokens":0},
 *      "prompt_tokens_details":{"cached_tokens":0},
 *      "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":28,
 *      "cache_read_input_tokens":0,"cache_creation_input_tokens":0,
 *      "prompt_cache_write_tokens":0,"cached_tokens":0}
 *
 * `prompt_tokens` **includes** the cached ones (the OpenAI convention this upstream follows).
 * The harness reads `inputTokens` as *uncached* input — `dsh-token-meter` does
 * `uncachedInputTokens: usage.inputTokens` and adds the cache buckets itself to get the pressure
 * total. Passing `prompt_tokens` through unchanged therefore counted every cached token as fresh
 * input and reported a cache-hit rate of zero on every turn, which is the one number that tells
 * a user whether their prefix is being reused. The pressure total stayed right, cached input
 * being counted once either way — which is why this never surfaced as a failure.
 *
 * A cached count larger than `prompt_tokens` cannot happen; trusting it would produce negative
 * input, which the harness's non-negative schema rejects outright, so the whole cache reading is
 * dropped rather than half-applied.
 *
 * @param {object} chunk
 * @returns {{inputTokens?: number, outputTokens?: number, reasoningTokens?: number,
 *   cacheReadTokens?: number, cacheWriteTokens?: number} | undefined}
 */
function readUsage(chunk) {
  const usage = chunk.usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const prompt = pick(usage.prompt_tokens) ?? pick(usage.input_tokens);
  const output = pick(usage.completion_tokens) ?? pick(usage.output_tokens);
  const reasoning = pick(usage.reasoning_tokens) ?? pick(usage.completion_tokens_details?.reasoning_tokens);
  if (prompt === undefined && output === undefined) return undefined;

  // Four spellings of "how much of the prompt was already cached", most specific first. The
  // upstream sends all of them; the nested one is the one it means.
  const cached =
    pick(usage.prompt_tokens_details?.cached_tokens) ??
    pick(usage.cached_tokens) ??
    pick(usage.prompt_cache_hit_tokens) ??
    pick(usage.cache_read_input_tokens);
  const written = pick(usage.prompt_cache_write_tokens) ?? pick(usage.cache_creation_input_tokens);

  const usable = prompt !== undefined && cached !== undefined && cached <= prompt ? cached : undefined;
  const uncached = usable === undefined ? prompt : prompt - usable;

  return {
    ...(uncached === undefined ? {} : { inputTokens: uncached }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(usable === undefined || usable === 0 ? {} : { cacheReadTokens: usable }),
    ...(written === undefined || written === 0 ? {} : { cacheWriteTokens: written })
  };
}

/**
 * An error carried inside an otherwise-successful SSE stream.
 *
 * The upstream sends these as a normal data frame, so a reader that only looked at
 * `choices` would render an error object as an empty answer.
 *
 * @param {object} chunk
 * @returns {string | undefined}
 */
function readError(chunk) {
  if (chunk.error !== undefined && chunk.error !== null) {
    const error = chunk.error;
    if (typeof error === 'string') return error.slice(0, 300);
    if (typeof error.message === 'string') return error.message.slice(0, 300);
    return JSON.stringify(error).slice(0, 300);
  }
  if (typeof chunk.code === 'number' && chunk.code !== 0) {
    return typeof chunk.msg === 'string' ? chunk.msg.slice(0, 300) : `code ${chunk.code}`;
  }
  return undefined;
}
