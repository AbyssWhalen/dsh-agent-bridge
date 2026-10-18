/**
 * Recovery for tool calls that arrive as text instead of as tool calls.
 *
 * DeepSeek models carry their own native call syntax — `<｜｜DSML｜｜invoke …>` with
 * `<｜｜DSML｜｜parameter …>` children — alongside the OpenAI `tool_calls` channel.
 * Normally the model uses the structured channel and this module never runs.
 * Occasionally it writes the native syntax into the *content* stream instead, and
 * then a turn that was meant to call a tool renders as raw markup in the chat,
 * which reads to a user as the plugin being broken.
 *
 * Two things make this worse than a cosmetic glitch, and both are why this module
 * exists rather than a note in the README:
 *
 * - **It is self-reinforcing.** Leaked markup is saved as assistant text. On the
 *   next turn it is replayed as history, and a model shown that syntax in its own
 *   voice imitates it. Left alone, one leak seeds more.
 * - **The intent is recoverable.** The markup carries the tool name and every
 *   parameter, so the call can be reconstructed exactly. Dropping it would throw
 *   away a turn the model had already decided how to spend.
 *
 * So: `parseLeakedCalls` turns a leaked block back into real calls, and
 * `stripLeak` keeps it out of replayed history.
 *
 * @module dsh-agent-bridge/dsml
 */

/**
 * The marker the native syntax is built from.
 *
 * Both the fullwidth vertical line (U+FF5C) and the ASCII `|` are accepted: the
 * fullwidth form is what the tokenizer emits, but a model that has seen the
 * ASCII spelling quoted in a conversation will reproduce that instead.
 */
/**
 * The delimiter body, with the bar count left open at one *or* two.
 *
 * The canonical spelling is two bars on each side, and that is what the tool
 * preamble teaches. Qwen-3.8-MAX writes the opening tags with a single bar
 * (`<｜｜DSML｜invoke …>`) while still closing with two — a one-character difference
 * that a `{2}` class rejects outright. Rejection is not a harmless miss: the text
 * is then not recognised as markup, so it streams to the screen as prose, gets
 * saved as assistant history, and the next turn imitates it. One real turn was
 * enough to produce a full wall of raw envelope in the chat.
 */
const BAR = '[\\uFF5C|]{1,2}';
const SEG = `${BAR}\\s*DSML\\s*${BAR}`;

/**
 * The marker, without requiring what follows it.
 *
 * Detection only needs the delimiter; the tag name is checked by the parsers.
 */
const MARKER = new RegExp(`<${SEG}`, 'u');

/** The same marker, for deletion passes that must hit every occurrence. */
const MARKER_ALL = new RegExp(`<${SEG}`, 'gu');

/** The longest prefix of a marker that could still become one, for tail holding. */
export const MARKER_MAX = 16;

/** One `invoke …</invoke>` block, with its name. */
const INVOKE = new RegExp(
  `<${SEG}\\s*invoke\\s+name="([^"]*)"\\s*>([\\s\\S]*?)</${SEG}\\s*invoke\\s*>`,
  'gu'
);

/** One `parameter …</parameter>` block inside an invoke, with its attributes. */
const PARAMETER = new RegExp(
  `<${SEG}\\s*parameter\\s+name="([^"]*)"([^>]*)>([\\s\\S]*?)</${SEG}\\s*parameter\\s*>`,
  'gu'
);

/** The enclosing `calls` wrapper and any stray closing tag. */
const NOISE = new RegExp(`</?${SEG}\\s*(?:calls|tool_calls)?\\s*>`, 'gu');

/**
 * A tag-shaped fragment of the syntax that survived block removal.
 *
 * An envelope cut mid-call never matches {@link INVOKE}, so its opening tag is
 * left behind by the block passes; without this it reaches the screen as
 * `invoke name="pwsh">` — markup stripped of the one token that made it
 * recognisable. Bounded to a single line so a stray marker cannot eat prose.
 */
const RESIDUE = new RegExp(
  `</?${SEG}\\s*(?:invoke|parameter|calls|tool_calls)?[^>\\n]*>`,
  'gu'
);

/**
 * This plugin's own rendered form: `[tool call: name {json}]`.
 *
 * Not the upstream's syntax — it is what `lib/messages.js` writes when it flattens
 * a call into text. A model shown that in its own history imitates it, which shows
 * up as a burst of pseudo-call text beside the real call. Recovered the same way.
 */
const RENDERED = /\[tool call:\s*([A-Za-z_$][\w$.-]*)\s*(\{[\s\S]*?\})?\s*\]/gu;

/**
 * Whether a string carries the upstream's own call syntax.
 *
 * This is the strict test, and the one the live stream uses. The bracketed
 * `[tool call: …]` form is deliberately *not* included: a model can be quoting it
 * — a user asking "print that marker verbatim" must get the text back, and turning
 * a quotation into an executed call is worse than showing a stray bracket. The
 * bracketed form is still cleaned out of replayed history, where it is not a
 * quotation but this plugin teaching itself a syntax.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasNativeLeak(value) {
  return typeof value === 'string' && MARKER.test(value);
}

/**
 * Whether a string carries either call syntax.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasLeak(value) {
  if (typeof value !== 'string') return false;
  return MARKER.test(value) || /\[tool call:/u.test(value);
}

/**
 * Every delimiter spelling a delta could be in the middle of writing.
 *
 * One or two bars on each side, independently: the canonical pair, the opening
 * pair Qwen emits, and the two mixed forms a tokenizer can split into.
 */
const MARKER_FORMS = ['<|DSML|', '<|DSML||', '<||DSML|', '<||DSML||'];

/**
 * Tag names that can follow a delimiter.
 *
 * A held tail is only released once it cannot be the start of one of these, which
 * is what keeps `<｜｜DSML｜｜` from being printed as text the instant the delimiter
 * completes.
 */
const TAG_NAMES = ['invoke', 'parameter', 'calls', 'tool_calls'];

/**
 * Whether a string ends with a prefix of the marker, so a split delta is caught.
 *
 * A marker can straddle two stream deltas; without this the tail is flushed as
 * text and only the remainder is recognised, which produces malformed output
 * that is worse than the original leak.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function endsWithMarkerPrefix(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Normalized so a fullwidth bar, an ASCII bar, and stray spaces all compare
  // equal: the same marker is written three ways across a model's output.
  const tail = value.slice(-MARKER_MAX).replace(/[\uFF5C]/gu, '|').replace(/\s+/gu, '');
  const at = tail.lastIndexOf('<');
  if (at < 0) return false;
  const candidate = tail.slice(at);
  for (const form of MARKER_FORMS) {
    // Still typing the delimiter itself.
    if (candidate.length < form.length && form.startsWith(candidate)) return true;
    // The delimiter is complete; hold until the tag name is ruled out, because a
    // released delimiter reaches the screen as `<｜｜DSML｜｜` with no context.
    if (candidate.startsWith(form)) {
      const after = candidate.slice(form.length);
      if (after.length === 0) return true;
      if (TAG_NAMES.some((name) => name.startsWith(after))) return true;
    }
  }
  return false;
}

/**
 * A plausible parameter name: one token, no spaces, no stray punctuation.
 *
 * Tool schemas use flat identifiers (`command`, `file_path`, `max-tokens`), so a
 * name carrying a space is a malformed tag rather than an exotic one.
 */
const NAME_OK = /^[A-Za-z_$][\w$.-]*$/u;

/**
 * Recover a parameter name from a tag whose attributes were written wrong.
 *
 * Qwen-3.8-MAX sometimes drops the closing quote after the name:
 *
 *     <…parameter name="command string="true">echo hi</…parameter>
 *
 * The name group then reads `command string=` and the declared type lands in the
 * leftover attributes. Kept as-is, the recovered call carries a key no tool schema
 * accepts, so the turn fails validation and the user sees an error even though the
 * call itself was recoverable. Splitting the first token off restores both the name
 * and the attribute it was glued to.
 *
 * @param {string} rawName
 * @param {string} rawAttributes
 * @returns {{name: string, attributes: string}}
 */
function parameterIdentity(rawName, rawAttributes) {
  const name = rawName.trim();
  if (NAME_OK.test(name)) return { name, attributes: rawAttributes };
  const at = name.search(/\s/u);
  if (at > 0) {
    const head = name.slice(0, at);
    if (NAME_OK.test(head)) {
      return { name: head, attributes: `${name.slice(at).trimEnd()}${rawAttributes}` };
    }
  }
  return { name, attributes: rawAttributes };
}

/**
 * Convert one parameter's text into the value its type attribute asks for.
 *
 * A tool schema that declares `{"count": 3}` rejects `"3"`, so the declared type
 * is honoured rather than defaulting everything to string.
 *
 * @param {string} raw
 * @param {string} attributes
 * @returns {unknown}
 */
function coerce(raw, attributes) {
  const declared = /(?:^|\s)(string|number|boolean|integer)="true"/u.exec(attributes)?.[1];
  if (declared === 'string') return raw;
  if (declared === 'number' || declared === 'integer') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (declared === 'boolean') return raw === 'true';
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && Number.isFinite(Number(trimmed)) && /^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  return raw;
}

/**
 * Recover the calls a leaked block was trying to make.
 *
 * @param {unknown} value - assistant text that contains the native syntax.
 * @returns {{calls: {name: string, arguments: string}[], rest: string, leaked: boolean}}
 *   `calls` in the order they appear; `rest` is the text that was not markup.
 */
export function parseLeakedCalls(value) {
  if (typeof value !== 'string' || !hasLeak(value)) {
    return { calls: [], rest: typeof value === 'string' ? value : '', leaked: false };
  }

  const calls = [];
  for (const invoke of value.matchAll(INVOKE)) {
    const name = invoke[1].trim();
    if (name.length === 0) continue;
    const body = invoke[2];
    const properties = {};
    for (const parameter of body.matchAll(PARAMETER)) {
      const key = parameter[1].trim();
      if (key.length === 0) continue;
      const identity = parameterIdentity(key, parameter[2]);
      properties[identity.name] = coerce(parameter[3], identity.attributes);
    }
    // A parameter-less tool is legal: `npm_test` takes nothing.
    calls.push({ name, arguments: JSON.stringify(properties) });
  }

  // The rendered form, when the model copied this plugin's own flattening.
  for (const rendered of value.matchAll(RENDERED)) {
    const name = rendered[1].trim();
    if (name.length === 0) continue;
    const raw = (rendered[2] ?? '').trim();
    if (raw === '') {
      calls.push({ name, arguments: '{}' });
      continue;
    }
    let argumentsJson;
    try {
      argumentsJson = JSON.stringify(JSON.parse(raw));
    } catch {
      // Not valid JSON: the block is not recoverable, so it is dropped rather
      // than sent upstream as an argument the tool schema will reject.
      continue;
    }
    calls.push({ name, arguments: argumentsJson });
  }

  // Everything that is not markup survives as text; an incomplete block (a
  // stream that was cut mid-call) is noise, not text, so it goes too.
  const rest = value
    .replace(INVOKE, '')
    .replace(RENDERED, '')
    .replace(NOISE, '')
    .replace(RESIDUE, '')
    .replace(MARKER_ALL, '')
    .trim();

  return { calls, rest, leaked: true };
}

/**
 * Remove the native syntax from a string, keeping whatever prose surrounded it.
 *
 * Used on replayed history: an assistant turn that leaked markup must not come
 * back as an example the model can copy.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stripLeak(value) {
  if (typeof value !== 'string' || !hasLeak(value)) return typeof value === 'string' ? value : '';
  return value
    .replace(INVOKE, '')
    .replace(RENDERED, '')
    .replace(NOISE, '')
    .replace(RESIDUE, '')
    .replace(MARKER_ALL, '')
    .trim();
}
