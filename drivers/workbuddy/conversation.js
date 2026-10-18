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
import { endsWithMarkerPrefix, hasLeak, hasNativeLeak, MARKER_MAX, parseLeakedCalls, stripLeak } from '../../lib/dsml.js';
import { assistantProse, flattenConversation, messageText, splitSystem } from '../../lib/messages.js';

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
  #closed = false;

  /**
   * @param {object} options
   * @param {import('./upstream.js').UpstreamClient} options.client
   * @param {() => Promise<object>} options.resolveCredential
   * @param {{debug?: Function, warn?: Function}} [options.logger]
   */
  constructor(options) {
    this.#client = options.client;
    this.#resolveCredential = options.resolveCredential;
    this.#logger = options.logger;
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
    const credential = await this.#resolveCredential();
    const list = Array.isArray(messages) ? messages : [];
    const region = this.#client.region;
    const tools = toWireTools(options.tools);

    const body = {
      model: options.model,
      messages: toWireMessages(list, region),
      stream: true,
      ...(typeof options.effort === 'string' && options.effort.length > 0 ? { reasoning_effort: options.effort } : {}),
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
    let stalled = false;
    let deadline = Date.now() + STREAM_IDLE_TIMEOUT_MS;

    // An idle *timeout*, not an interval: a long answer that keeps producing
    // frames must never be killed by the clock. The old version fired once from
    // stream start regardless of traffic, so a slow but healthy turn died at the
    // mark with "produced nothing", which was a lie.
    const timer = setInterval(() => {
      if (queue.closed) return;
      if (Date.now() < deadline) return;
      stalled = true;
      queue.fail(new Error(`workbuddy: the stream produced nothing for ${STREAM_IDLE_TIMEOUT_MS}ms`));
    }, Math.min(STREAM_IDLE_TIMEOUT_MS, 5_000));
    timer.unref?.();

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

    // Text is held back by a marker's length so a call that arrives as text can
    // still be recognized. Only the tail is at risk: a full marker is detected on
    // sight, and the last few characters are held until they either disambiguate
    // or prove to be an ordinary '<'.
    let pendingText = '';
    let heldText = '';
    let holding = false;

    // The reasoning channel gets the same treatment. It is shown while the turn
    // streams, so markup written there is just as visible — and it is replayed as
    // history, so it seeds the same imitation. Nothing is recovered from it: the
    // real call arrives on its own channel.
    let pendingReasoning = '';

    const flushText = (part) => {
      if (part.length === 0) return;
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
      queue.push({ type: 'reasoning-delta', index: reasoningIndex, text: pendingReasoning.slice(0, release) });
      pendingReasoning = pendingReasoning.slice(release);
    };

    /** Release reasoned text that was held back, then drop any markup in it. */
    const settleReasoning = () => {
      if (pendingReasoning.length === 0) return;
      const cleaned = hasLeak(pendingReasoning) ? stripLeak(pendingReasoning) : pendingReasoning;
      if (cleaned.length > 0) {
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
        } else {
          flushText(pendingText);
          pendingText = '';
          return;
        }
      }
      if (!holding) return;
      const native = /DSML/u.test(heldText);
      const recovered = native
        ? parseLeakedCalls(heldText)
        : { calls: [], rest: stripLeak(heldText), leaked: true };
      heldText = '';
      holding = false;
      if (recovered.calls.length === 0) {
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
                  deadline = Date.now() + STREAM_IDLE_TIMEOUT_MS;
                  const usage = readUsage(parsed);
                  if (usage !== undefined) sawUsage = usage;
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
        if (!stalled) queue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    try {
      yield* queue;
      if (sawUsage !== undefined) yield { type: 'usage', usage: sawUsage };
      yield { type: 'finish', reason: { kind: sawToolCall ? 'tool-calls' : 'stop' } };
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
 * @param {{role: string, text: string, toolCalls?: {id: string, name: string, arguments: string}[], toolCallId?: string}[]} messages
 * @param {'cn' | 'global'} region
 * @returns {object[]}
 */
export function toWireMessages(messages, region) {
  const { system, rest } = splitSystem(messages);
  const wire = [];
  if (system.length > 0) wire.push({ role: 'system', content: system });
  for (const message of rest) {
    const calls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    // An assistant turn that carries real calls must not also carry the rendered
    // `[tool call: …]` form: the model reads its own history and copies that
    // spelling, producing a burst of pseudo-call text beside the real call.
    const text =
      message.role === 'assistant'
        ? stripLeak(calls.length > 0 ? assistantProse(message) : messageText(message))
        : messageText(message);
    if (message.role === 'tool') {
      if (text.length === 0) continue;
      if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) {
        wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: text });
        continue;
      }
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
 * Token usage from one chunk, when the upstream reports it.
 *
 * @param {object} chunk
 * @returns {{inputTokens?: number, outputTokens?: number, reasoningTokens?: number} | undefined}
 */
function readUsage(chunk) {
  const usage = chunk.usage;
  if (usage === null || typeof usage !== 'object') return undefined;
  const pick = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const input = pick(usage.prompt_tokens) ?? pick(usage.input_tokens);
  const output = pick(usage.completion_tokens) ?? pick(usage.output_tokens);
  const reasoning = pick(usage.reasoning_tokens) ?? pick(usage.completion_tokens_details?.reasoning_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning })
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
