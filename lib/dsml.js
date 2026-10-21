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
 * The delimiter body, written the two ways the models actually write it.
 *
 * The canonical spelling is two bars, the letters `DSML`, two bars. Two degradations
 * of it are real, both observed from a live account rather than imagined:
 *
 * 1. **The letters are dropped.** Qwen-3.8-MAX writes `<｜｜｜｜｜invoke name="pwsh">` —
 *    five bars and no `DSML` at all. Requiring the literal letters rejects the whole
 *    envelope, so nothing is recovered, the markup streams to the screen as prose,
 *    and the tool never runs. That is not a cosmetic miss: the turn was spent, the
 *    model had decided which call to make, and the user gets a wall of bars.
 * 2. **The bar count drifts.** `<｜｜DSML｜invoke` closes with one bar; the canonical
 *    pair is two. A `{2}` class rejects it outright.
 *
 * So the bar count is left open at one to eight and the letters are optional — but
 * the *bare* form is only accepted when a tag name follows it, because a stray `<||`
 * in ordinary code is not a call and must not be treated as one.
 */
const BARS = '[\\uFF5C|]';

/** Bars with the letters in them, in any of the observed bar counts. */
const DELIMITER_LETTERED = `${BARS}{1,8}\\s*DSML\\s*${BARS}{0,8}`;

/** Bars alone: what the delimiter degrades to once the letters are gone. */
const DELIMITER_BARE = `${BARS}{2,8}`;

/** Either spelling, where the surrounding tag name makes the meaning explicit. */
const SEG = `(?:${DELIMITER_LETTERED}|${DELIMITER_BARE})`;

/**
 * The marker, for detection.
 *
 * Unlike {@link SEG} this carries a lookahead: the bare form is a bare run of bars,
 * which is common enough in code and prose that treating every `<||` as the start of
 * a call would hold and then mangle text that never had a call in it. The lettered
 * form needs no such guard — nobody writes `<｜｜DSML｜｜` by accident.
 */
const MARKER = new RegExp(
  `<${DELIMITER_LETTERED}|<${DELIMITER_BARE}(?=\\s*(?:invoke|parameter|calls|tool_calls)\\b)`,
  'u'
);

/** The same marker, for deletion passes that must hit every occurrence. */
const MARKER_ALL = new RegExp(
  `<${DELIMITER_LETTERED}|<${DELIMITER_BARE}(?=\\s*(?:invoke|parameter|calls|tool_calls)\\b)`,
  'gu'
);

/**
 * The longest prefix of a marker that could still become one, for tail holding.
 *
 * Sized for the widest spelling: `<` + eight bars + `DSML` + eight bars.
 */
export const MARKER_MAX = 32;

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
 * Tag names that can follow a delimiter.
 *
 * A held tail is only released once it cannot be the start of one of these, which
 * is what keeps `<｜｜DSML｜｜` from being printed as text the instant the delimiter
 * completes. It is also what keeps the bare bar spelling from matching prose: the
 * lookahead in {@link MARKER} accepts a bare run of bars only ahead of one of these.
 */
const TAG_NAMES = ['invoke', 'parameter', 'calls', 'tool_calls'];

/**
 * Whether a string ends with a prefix of the marker, so a split delta is caught.
 *
 * A marker can straddle two stream deltas; without this the tail is flushed as
 * text and only the remainder is recognised, which produces malformed output
 * that is worse than the original leak.
 *
 * Written against the normalized tail rather than a fixed list of spellings: the
 * bar count drifts and the letters can vanish, so a list of known forms is always
 * one model version behind.
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
  const body = tail.slice(at + 1);

  // Still typing the delimiter itself: `<`, then any run of bars.
  if (body.length === 0) return true;
  if (/^\|{1,8}$/u.test(body)) return true;
  // The letters arriving one at a time after the opening bars.
  if (/^\|{1,8}D?(?:S(?:M(?:L)?)?)?$/u.test(body)) return true;
  // The delimiter is complete; hold until a tag name rules it out, because a
  // released delimiter reaches the screen as `<｜｜DSML｜｜` with no context.
  if (/^\|{1,8}DSML\|{0,8}$/u.test(body)) return true;

  const opened = /^(?:\|{1,8}DSML\|{0,8}|\|{2,8})([a-z_]*)$/u.exec(body);
  if (opened !== null) {
    const after = opened[1];
    if (after.length === 0) return true;
    return TAG_NAMES.some((name) => name.startsWith(after));
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
