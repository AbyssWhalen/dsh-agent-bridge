/**
 * Canonical message projection shared by every driver.
 *
 * Drivers are deliberately kept free of any DSH dependency so the same code can
 * later back an OpenAI-compatible shell (see the construction spec §10). The
 * cost of that freedom is that a driver cannot read the harness's `Message`
 * objects — so the harness shape is projected here, once, into the small
 * vendor-neutral form every driver actually consumes:
 *
 *     { role: 'user' | 'assistant' | 'system' | 'tool', text: string }
 *
 * Everything a driver does with a conversation — flatten it into one prompt,
 * replay it as a JSON body, fingerprint it for append detection — is built from
 * this list and nothing else.
 *
 * @module dsh-agent-bridge/messages
 */

/**
 * Flatten one content block into text.
 *
 * Text and reasoning blocks carry `text`. Tool calls and tool results are
 * rendered as a compact, clearly delimited pseudo-syntax: the proxy target is a
 * chat model reached without any tool channel, so a tool exchange in the
 * history is context to read, not something to replay verbatim.
 *
 * @param {unknown} content - a message's `content`, as an array or a string.
 * @returns {string} the text of every readable block, newline-joined.
 */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const { type } = block;
    if ((type === 'text' || type === 'reasoning') && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (type === 'tool-call' && typeof block.name === 'string') {
      // The arguments belong here: a transcript that names the tool but drops what
      // it was asked to do is not a record of the turn, and a model replaying it
      // cannot tell one call from another.
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
      parts.push(`[tool call: ${block.name} ${args}]`);
    } else if (type === 'tool-result') {
      const body = contentText(block.content);
      parts.push(body.length === 0 ? '[tool result]' : `[tool result]\n${body}`);
    }
  }
  return parts.join('\n');
}

/**
 * A human-readable label for one message role.
 *
 * The flattened transcript is read by a chat model with no knowledge of this
 * harness, so roles are spelled the way a conversation is normally written.
 *
 * @param {string} role
 * @returns {string}
 */
export function roleLabel(role) {
  if (role === 'assistant') return 'Assistant';
  if (role === 'system' || role === 'developer') return 'System';
  if (role === 'tool') return 'Tool result';
  return 'User';
}

/**
 * The tool calls an assistant message asked for.
 *
 * A driver facing an OpenAI-shaped wire does not get to replay `[tool call: …]`
 * prose: the upstream that issued the calls expects them back as structured
 * `tool_calls`, and a `tool` result is only addressable through the id it answers.
 * So the projection keeps that structure beside the text instead of inside it.
 *
 * @param {unknown} content - a message's `content`.
 * @returns {{id: string, name: string, arguments: string}[]}
 */
export function toolCallsOf(content) {
  const calls = [];
  if (!Array.isArray(content)) return calls;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'tool-call' || typeof block.name !== 'string') continue;
    calls.push({
      id: typeof block.id === 'string' && block.id.length > 0 ? block.id : `call_${calls.length}`,
      name: block.name,
      arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
    });
  }
  return calls;
}

/**
 * Collapse `developer` and `system` messages into the single `system` role.
 *
 * The harness emits its own prompt under `developer` for OpenAI-shaped vendors;
 * a driver that accepts a system field wants one string, not a role the target
 * may reject outright.
 *
 * @param {readonly {role?: string, content?: unknown, toolCallId?: string}[]} messages
 * @returns {{role: string, text: string, toolCalls?: {id: string, name: string, arguments: string}[], toolCallId?: string}[]} the projected list, in order.
 */
export function normalizeMessages(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const rawRole = typeof message.role === 'string' ? message.role : 'user';
    const role = rawRole === 'developer' ? 'system' : rawRole;
    const text = contentText(message.content);
    // A tool role with no readable body carries no information; dropping it
    // keeps the transcript honest instead of inventing an empty turn.
    if (role === 'tool' && text.length === 0) continue;
    const toolCalls = role === 'assistant' ? toolCallsOf(message.content) : [];
    const toolCallId = typeof message.toolCallId === 'string' && message.toolCallId.length > 0 ? message.toolCallId : undefined;
    out.push({
      role,
      text,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(toolCallId === undefined ? {} : { toolCallId })
    });
  }
  return out;
}

/**
 * The text of one message, whether or not it has already been projected.
 *
 * Drivers are handed projected messages, but these helpers are also reached
 * directly — a driver's own test, a future non-DSH shell — so reading `content`
 * as a fallback keeps a raw harness message from being read as empty. An empty
 * read is the dangerous failure here: it produces a prompt with the conversation
 * missing, which looks like a model that ignored the question.
 *
 * @param {{role?: string, text?: unknown, content?: unknown}} message
 * @returns {string}
 */
function readText(message) {
  if (message === null || typeof message !== 'object') return '';
  if (typeof message.text === 'string') return message.text;
  return contentText(message.content);
}

/**
 * The text of one message, whether or not it has already been projected.
 *
 * Exported because drivers need this tolerance when they build a wire body
 * themselves; see {@link readText} for why an empty read is the failure to avoid.
 *
 * @param {{role?: string, text?: unknown, content?: unknown}} message
 * @returns {string}
 */
export function messageText(message) {
  return readText(message);
}

/**
 * The prose of an assistant message, without any rendered tool-call markup.
 *
 * This exists because of a self-inflicted failure. {@link contentText} renders a
 * call as `[tool call: name {args}]` so a tool exchange is readable in a flattened
 * transcript. That is right for a prompt-only driver and wrong for one that also
 * sends structured `tool_calls`: the same turn then carries both, and a model
 * reading its own history sees the bracketed form as the house style. It copies
 * it. The copied text is not a call, so the turn renders as a burst of what looks
 * like errors while the real call happens behind it.
 *
 * A message that already carries structured calls therefore contributes only its
 * genuine words. `reasoning` counts as words: the harness shows it, and dropping
 * it from history would lose the model's own thread.
 *
 * @param {{text?: unknown, content?: unknown}} message
 * @returns {string}
 */
export function assistantProse(message) {
  if (message === null || typeof message !== 'object') return '';
  if (typeof message.text === 'string' && !Array.isArray(message.content)) return message.text;
  const content = message.content;
  if (!Array.isArray(content)) return typeof message.text === 'string' ? message.text : '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if ((block.type === 'text' || block.type === 'reasoning') && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    // A tool call block contributes nothing here — it travels as `tool_calls`.
    // A tool result inside an assistant turn is not a thing; skipping is honest.
  }
  if (parts.length === 0 && typeof message.text === 'string') return message.text;
  return parts.join('\n');
}

/**
 * Pull the leading system turns out of a projected list.
 *
 * A message list can begin with several system turns (the harness prompt plus
 * the host's preamble). Prompt-only drivers want those as one string and the
 * remainder as a plain conversation.
 *
 * @param {readonly {role: string, text: string}[]} messages
 * @returns {{system: string, rest: {role: string, text: string}[]}}
 */
export function splitSystem(messages) {
  const parts = [];
  let index = 0;
  while (index < messages.length && messages[index].role === 'system') {
    const text = readText(messages[index]);
    if (text.length > 0) parts.push(text);
    index += 1;
  }
  return { system: parts.join('\n\n'), rest: messages.slice(index) };
}

/**
 * Render a whole conversation as one prompt string.
 *
 * Used by vendors whose only entry point is "send this text" — the CLI-backed
 * and worker-backed drivers. Every turn is labelled so the model can tell who
 * said what, and the final user turn is repeated after the transcript so the
 * actual instruction is unambiguous.
 *
 * @param {readonly {role: string, text: string}[]} messages
 * @returns {string}
 */
export function flattenConversation(messages) {
  if (messages.length === 0) return '';
  const last = messages[messages.length - 1];
  if (messages.length === 1 && last.role === 'user') return readText(last);
  let end = messages.length;
  while (end > 0 && messages[end - 1].role !== 'user') end -= 1;
  const head = end === messages.length ? messages : messages.slice(0, end);
  const prompt = end === messages.length ? '' : readText(messages[messages.length - 1]);
  if (head.length === 0) return prompt;
  const transcript = head.map((message) => `${roleLabel(message.role)}: ${readText(message)}`).join('\n\n');
  return `[Conversation so far]\n${transcript}\n[End of conversation so far]\n\n${prompt}`;
}

/**
 * Render a whole conversation faithfully, tool exchange included.
 *
 * {@link flattenConversation} is written for the case "the last thing the user said is
 * the instruction", and it drops everything after the final user turn because the tail
 * is then repeated separately. That is right for a chat driver and wrong for a replay
 * into a child process that has **no history of its own** — a worker that just started,
 * or one that died and was replaced. In that case the dropped tail is the only record
 * of the exchange, and what survives is an answer to a question nobody asked:
 *
 *     [Conversation so far]
 *     User: List the files here.
 *     [End of conversation so far]
 *
 *     alpha.txt
 *     beta.txt
 *
 * Read by a model, that is the user listing two filenames. The call that produced them
 * is gone, so the model cannot know a tool ran at all, and it re-runs the command or
 * reports the names as if it had been told them. Measured, not imagined: see
 * `_probe/qoder-framing-cost.mjs`, whose cold-child case prints exactly the prompt
 * above with `names the tool call: false`.
 *
 * So this renders every message in order, names each call's id, and labels each result
 * with the id it answers. The ids are what make the pairing legible; without them a
 * multi-call turn is a pile of unattributed output.
 *
 * @param {readonly {role?: string, text?: unknown, content?: unknown, toolCalls?: {id: string, name: string, arguments: string}[], toolCallId?: string}[]} messages
 * @returns {string}
 */
export function flattenTranscript(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  // A conversation with nothing but the question is just the question. Wrapping it in
  // transcript markers would tell a fresh child that something preceded it.
  if (messages.length === 1 && messages[0]?.role === 'user') return readText(messages[0]);
  const lines = [];
  for (const message of messages) {
    const calls = callsOfMessage(message);
    const text = readText(message);
    if (message?.role === 'tool') {
      lines.push(`${roleLabel('tool')} ${resultLabel(message)}:\n${text.length === 0 ? '(empty)' : text}`);
      continue;
    }
    if (calls.length > 0) {
      // `assistantProse`, not `readText`: a raw content block that carries the call
      // renders it as `[tool call: …]` on its own, and rendering it again beside that
      // printed the same call twice — once without its id, once with.
      const prose = assistantProse(message);
      const rendered = calls.map((call) => `[tool call: ${call.name} ${call.arguments} (id ${call.id})]`).join('\n');
      lines.push(`${roleLabel('assistant')}: ${prose.length === 0 ? rendered : `${prose}\n${rendered}`}`);
      continue;
    }
    if (text.length === 0) continue;
    lines.push(`${roleLabel(message?.role)}: ${text}`);
  }
  if (lines.length === 0) return '';
  return `[Conversation so far]\n${lines.join('\n\n')}\n[End of conversation so far]\n`;
}

/**
 * Render only the messages being appended to a child that already has the rest.
 *
 * The child holds the conversation up to this point, so re-sending history would
 * duplicate it. What it does not have is the result, and a bare result is ambiguous —
 * the model cannot tell whether the user pasted it or a tool produced it. Naming the
 * call it answers is what resolves that, and it is the whole reason this is separate
 * from {@link flattenTranscript}.
 *
 * @param {readonly {role?: string, text?: unknown, content?: unknown, toolCalls?: {id: string, name: string, arguments: string}[], toolCallId?: string}[]} messages
 * @returns {string}
 */
export function appendPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const parts = [];
  for (const message of messages) {
    const text = readText(message);
    if (message?.role === 'tool') {
      parts.push(`${roleLabel('tool')} ${resultLabel(message)}:\n${text.length === 0 ? '(empty)' : text}`);
      continue;
    }
    if (callsOfMessage(message).length > 0) {
      // The child wrote this turn itself — a call it made is already in its history, and
      // echoing it back attributes the model's own words to the user.
      continue;
    }
    if (text.length > 0) parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * One tool result's label, carrying the id it answers.
 *
 * @param {{toolCallId?: string}} message
 * @returns {string}
 */
function resultLabel(message) {
  const id = typeof message?.toolCallId === 'string' && message.toolCallId.length > 0 ? message.toolCallId : 'unknown';
  return `for ${id}`;
}

/**
 * The calls one message asked for, whether or not it has been projected.
 *
 * A projected message carries them beside the text (`toolCalls`), a raw one has them
 * inside `content`. Reading only one shape is how the calls went missing once before.
 *
 * @param {{role?: string, toolCalls?: {id: string, name: string, arguments: string}[], content?: unknown}} message
 * @returns {{id: string, name: string, arguments: string}[]}
 */
function callsOfMessage(message) {
  if (message === null || typeof message !== 'object') return [];
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return message.toolCalls;
  return toolCallsOf(message.content);
}

/**
 * A stable fingerprint of one projected message.
 *
 * The NUL separators keep the fields unambiguous: a role that ends in the same
 * characters another begins with can never make two different messages hash the
 * same.
 *
 * @param {{role: string, text: string}} message
 * @returns {string}
 */
export function messageFingerprint(message) {
  const text = readText(message);
  return `${message.role}\0${text.length}\0${text}`;
}

/**
 * Whether `next` extends `previous` by a tail the child can be told about directly.
 *
 * This is the only history change a stateful driver can express without replaying: the
 * prefix is unchanged and there is something new at the end. The prefix comparison is
 * exact — a fingerprint match, not a similarity guess — because a replayed turn and an
 * appended one must never be confused.
 *
 * The tail may end either with a user turn (the ordinary next question) or with a tool
 * result (the answer to a call the child itself just made). The second case used to be
 * refused, so **every** tool exchange replayed the transcript instead of appending one
 * result. That refusal also hid a worse problem: see {@link flattenTranscript}. A tail
 * with a user turn anywhere but the end is a genuine divergence and still replays.
 *
 * @param {readonly string[]} previous - fingerprints of what the driver last sent.
 * @param {readonly {role: string, text: string}[]} next - the projected list now.
 * @returns {boolean}
 */
export function isStraightAppend(previous, next) {
  if (previous.length === 0) return false;
  if (next.length < previous.length + 1) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (messageFingerprint(next[index]) !== previous[index]) return false;
  }
  const added = next.slice(previous.length);
  if (added.length === 0) return false;
  const last = added[added.length - 1].role;
  if (last !== 'user' && last !== 'tool') return false;
  // At most one user turn, and only as the very last message: two would mean the
  // history contains turns this child was never told about.
  return added.every((message, index) => index === added.length - 1 || message.role !== 'user');
}
