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
 * The delimiter body, written the ways the models actually write it.
 *
 * The canonical spelling is two bars, the letters `DSML`, two bars. Several degradations
 * of it are real, all observed from live accounts rather than imagined:
 *
 * 1. **The letters are dropped.** Qwen-3.8-MAX writes `<｜｜｜｜｜invoke name="pwsh">` —
 *    five bars and no `DSML` at all. Requiring the literal letters rejects the whole
 *    envelope, so nothing is recovered, the markup streams to the screen as prose,
 *    and the tool never runs. That is not a cosmetic miss: the turn was spent, the
 *    model had decided which call to make, and the user gets a wall of bars.
 * 2. **The bar count drifts.** Seven bars open `invoke`, five close `parameter`; the
 *    canonical pair is two. A `{2}` class rejects it outright.
 * 3. **A word lands between the opening bars and `DSML`.** The live captures contain
 *    `<｜toolDSML｜｜calls>` — the model half-wrote `<｜tool_calls>` and half-wrote the
 *    delimiter. The word is at most a dozen characters of tag name and is followed by
 *    `DSML`, which nobody writes by accident.
 *
 * So the bar count is left open at one to eight, the letters are optional, and a short
 * word may precede them — but the *bare* form is only accepted when a tag name follows
 * it, because a stray `<||` in ordinary code is not a call and must not be treated as
 * one. One bar is enough for the bare form: `<｜tool_call>` and `<｜tool_name>` are both
 * real, and one bar alone cannot match prose without the tag-name lookahead.
 */
const BARS = '[\\uFF5C|]';

/**
 * How many bars a delimiter may contain.
 *
 * Not a guess about the usual count but a generous ceiling: live captures contain
 * twenty-three bars opening `invoke`, and a cap of eight rejected the whole envelope.
 * What makes a long run safe to accept is the tag name that follows it, not its length —
 * prose does not write `<` + twenty bars + `invoke`.
 */
const BARS_MAX = 32;

/**
 * U+2581, the glyph a tokenizer uses in place of a space in a token's readable form.
 *
 * `▁begin` and `_begin` are the same token seen two ways depending on where the text was
 * rendered, so every spelling below accepts either one, in runs.
 */
const SPACE_GLYPH = '[\\u2581_]';

/**
 * The model's own function-calling control tokens, arriving in the content stream.
 *
 * These are not a dialect a model invented to work around a broken harness — they are the
 * tokenizer's reserved tokens (`<|begin_of_tool_call|>`, `<|tool_sep|>`,
 * `<|end_of_tool_call|>`) surfacing as text, with U+2581 standing in for the underscores
 * and U+FF5C bars standing in for the pipes. Captured live:
 *
 *   <｜｜｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh
 *   ```json
 *   {"command": "Get-ChildItem -Force"}
 *   ```<｜｜DSML｜｜call▁end｜>
 *
 * The arguments arrive as a fenced JSON object rather than as `<parameter>` tags, which
 * makes this the easiest dialect to recover: the fence already holds an argument bag, so
 * there is no tag grammar to mis-read. It went unrecognised only because it had not been
 * seen before.
 *
 * Declared here rather than beside the parser because {@link MARKER} has to see them: a
 * marker the detector does not know is a marker the stream will release as text.
 */
const NATIVE_BEGIN = `<${BARS}{1,${BARS_MAX}}(?:${SPACE_GLYPH})*begin(?:${SPACE_GLYPH}*(?:of${SPACE_GLYPH}*)?(?:tool${SPACE_GLYPH}*call)?)?${BARS}{0,${BARS_MAX}}>`;
const NATIVE_SEP = `<${BARS}{1,${BARS_MAX}}tool(?:${SPACE_GLYPH})*sep(?:${SPACE_GLYPH})*${BARS}{0,${BARS_MAX}}>`;
const NATIVE_END = `<${BARS}{1,${BARS_MAX}}(?:DSML${BARS}{0,${BARS_MAX}})?(?:${SPACE_GLYPH})*(?:call${SPACE_GLYPH}*)?end(?:${SPACE_GLYPH}*of${SPACE_GLYPH}*(?:tool${SPACE_GLYPH}*call)?)?${BARS}{0,${BARS_MAX}}>`;

/** `begin` + the literal word `function` + `sep` + name + body + `end`. */
const NATIVE_CALL = new RegExp(
  `${NATIVE_BEGIN}\\s*function\\s*${NATIVE_SEP}\\s*([A-Za-z_$][\\w$.-]*)([\\s\\S]*?)${NATIVE_END}`,
  'gi'
);

/** The fenced block holding the arguments. `json` is the language tag the capture used. */
const ARGUMENT_FENCE = /```[ \t]*(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)```/i;

/** Bars with the letters in them, allowing a word in front of `DSML` and any bar count. */
const DELIMITER_LETTERED = `${BARS}{1,${BARS_MAX}}\\s*[A-Za-z_]{0,12}\\s*DSML\\s*${BARS}{0,${BARS_MAX}}`;

/** Bars alone: what the delimiter degrades to once the letters are gone. */
const DELIMITER_BARE = `${BARS}{1,${BARS_MAX}}`;

/** Either spelling, where the surrounding tag name makes the meaning explicit. */
const SEG = `(?:${DELIMITER_LETTERED}|${DELIMITER_BARE})`;

/**
 * Tag names that can follow a delimiter.
 *
 * Two syntaxes are in here because the models use both. `invoke`/`parameter`/`calls` is
 * the DSML family; `tool_call`/`tool_name`/`argument`/`name` is what a model invents when
 * the first one appears not to work. Only being able to name the first family is why the
 * second one leaked: the marker was never detected, so no block was ever held, so nothing
 * was ever recovered.
 */
const TAG_NAMES = [
  'invoke',
  'parameter',
  'tool_calls',
  'tool_call',
  'tool_name',
  'tool_response',
  'arguments',
  'argument',
  'calls',
  // `call`, singular, is what the displacement dialect writes (`<｜｜｜｜call invoke="name">`).
  // Listing it is not cosmetic: the bare delimiter only counts as a marker ahead of a known
  // tag name, so a block opening with `call` was invisible to the stream hold and its opening
  // reached the screen before the rest of the shape made the dialect recognisable.
  'call',
  'name'
];

/**
 * The container element some captures wrap a call in: `<｜tool>`.
 *
 * Deliberately *not* added to {@link TAG_NAMES}: `<tool>` is ordinary markup in prose about
 * markup — this plugin's own documentation writes it — and listing the bare word would make
 * the cleanup passes eat it out of a sentence. Matching it only with a delimiter in front
 * gives the stream what it needs (see {@link MARKER}) without touching prose.
 */
const CONTAINER = `<${DELIMITER_BARE}\\s*tool\\s*>`;

/**
 * The reserved-token separators a model uses when it half-remembers its own tokenizer.
 *
 * Measured live (Qoder, `kmodel_latest`, 2026-10-23) — a whole call written as text:
 *
 *     <｜｜DSML｜｜ invoke name="pwsh">
 *     <｜｜DSML｜｜DSML｜parameter name="command">Get-ChildItem<|open|>argument key="description" type="string"<|sep|>List files
 *
 * The opening markers are the fullwidth single bar this file already accepts. What is new is how
 * the *arguments* are delimited: not `</parameter>`, but the model's own reserved tokens
 * `<|open|>` and `<|sep|>`, with the name written `key=`.
 *
 * Why this matters more than a cosmetic miss: with nothing matching, `parseLeakedCalls` recovered
 * zero calls, and the driver's fallback for "call syntax it cannot read" is to show the block **as
 * written**. The user got a wall of markers where an answer should have been, and the tool never
 * ran. Both halves are asserted in `test/dsml-reserved-tokens.mjs`.
 */
const OPEN_TOKEN = `<${BARS}{1,${BARS_MAX}}\\s*(?:open|begin_of_[\\w]*)\\s*${BARS}{0,${BARS_MAX}}>`;
const SEP_TOKEN = `<${BARS}{1,${BARS_MAX}}\\s*(?:sep|tool[\\s_]*sep|separator)\\s*${BARS}{0,${BARS_MAX}}>`;

/**
 * One `<parameter name="x">value` argument that is closed by a *separator* rather than a tag.
 *
 * The reserved-token dialect writes the first argument with the ordinary opener and then moves
 * on to `<|open|>argument key=…` for the rest, so the first one is never closed:
 *
 *     <｜｜DSML｜｜ parameter name="command">Get-ChildItem<|open|>argument key="description" …
 *
 * Without this, `command` was silently dropped while every later argument survived — the worst
 * possible outcome, because the call still parsed and would have run with its main argument
 * missing. The value therefore stops at the first separator, at the next opener, or at the end.
 */
const SEPARATOR_CLOSED_PARAMETER = new RegExp(
  `<${SEG}\\s*(?:parameter\\s+)?(?:name|key)="([^"]*)"([^>]*)>([\\s\\S]*?)(?=${OPEN_TOKEN}|</${SEG}\\s*parameter|</${SEG}\\s*invoke|$)`,
  'gu'
);

/**
 * One `<|open|>argument key="x" type="t"<|sep|>value` argument.
 *
 * The `<|open|>` in front is optional because the first argument of a block follows the
 * `</parameter>`-shaped opener instead, and it belongs to the previous argument rather than to
 * this one. The value stops at the next `<|open|>` — that is what makes the run a list rather
 * than one long string; with no closing tag to stop at, without that lookahead the last argument
 * would swallow every following one.
 */
const SEPARATED_ARGUMENT = new RegExp(
  `(?:${OPEN_TOKEN}\\s*)?argument\\s+(?:name|key)="([^"]*)"([^>]*?)${SEP_TOKEN}([\\s\\S]*?)(?=${OPEN_TOKEN}|</${SEG}\\s*invoke|$)`,
  'gu'
);

/**
 * The marker, for detection.
 *
 * Unlike {@link SEG} this carries a lookahead: the bare form is a bare run of bars,
 * which is common enough in code and prose that treating every `<||` as the start of
 * a call would hold and then mangle text that never had a call in it. The lettered
 * form needs no such guard — nobody writes `<｜｜DSML｜｜` by accident.
 *
 * The native control tokens are listed whole rather than by lookahead: `<｜｜｜▁begin｜` is
 * itself the evidence, and no prose writes U+2581 between bars. Leaving them out was
 * exactly the gap that let a native call stream to the screen — the block's opening token
 * did not look like a marker, so the hold never engaged and the text was already out by
 * the time `tool▁sep` made the shape recognisable.
 *
 * The container tag is here for the same reason and shows up as the same failure: a call
 * that opens `<｜tool>` with no wrapper above it emitted that tag as text, the hold never
 * engaged, and because a `tool_name` element carries no bars of its own nothing downstream
 * was recognised either — measured `calls=0` with the whole block on screen.
 */
const MARKER = new RegExp(
  `<${DELIMITER_LETTERED}|<${DELIMITER_BARE}(?=\\s*(?:${TAG_NAMES.join('|')})\\b)|${NATIVE_BEGIN}|${NATIVE_SEP}|${CONTAINER}`,
  'u'
);

/** The same marker, for deletion passes that must hit every occurrence. */
const MARKER_ALL = new RegExp(
  `<${DELIMITER_LETTERED}|<${DELIMITER_BARE}(?=\\s*(?:${TAG_NAMES.join('|')})\\b)|${NATIVE_BEGIN}|${NATIVE_SEP}|${CONTAINER}`,
  'gu'
);

/**
 * The longest prefix of a marker that could still become one, for tail holding.
 *
 * Sized for the widest spelling: `<` + eight bars + a twelve-letter word + `DSML` +
 * eight bars.
 */
export const MARKER_MAX = 64;

/**
 * A run of fullwidth bars long enough that it can only be a repetition loop.
 *
 * Not a call syntax at all — a degenerate turn where the model repeats the `｜` token
 * until it runs out of budget. Live captures contain runs of 500. Nothing is recoverable
 * from it, so the only useful behaviour is to stop it reaching the screen and to tell the
 * caller the turn produced nothing, rather than render half a thousand bars.
 *
 * The length alone is not the tell: a run of thirty bars that opens `invoke` is a
 * delimiter with a drifting count, and rejecting it would discard a real call. What makes
 * the run degenerate is that no tag name follows it, which is the lookahead below.
 *
 * The threshold is on the fullwidth bar alone: the ASCII `|` is ordinary in tables and
 * shell snippets, so it is left out of both the rule and the rewrite.
 */
export const DEGENERATE_BARS = 24;

/** A runaway bar run, for detection. Deliberately not global: `.test()` on a global
 * regex advances `lastIndex` and the next call answers differently. */
const RUNAWAY = new RegExp(`\\uFF5C{${DEGENERATE_BARS},}(?!\\s*[A-Za-z_])`, 'u');

/** The same rule, for the deletion passes. */
const RUNAWAY_ALL = new RegExp(`\\uFF5C{${DEGENERATE_BARS},}(?!\\s*[A-Za-z_])`, 'gu');

/**
 * Whether a string contains a repetition loop rather than content.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDegenerate(value) {
  return typeof value === 'string' && RUNAWAY.test(value);
}


/** One `invoke …</invoke>` block, with its name. */
const INVOKE = new RegExp(
  `<${SEG}\\s*invoke\\s+name="([^"]*)"\\s*>([\\s\\S]*?)</${SEG}\\s*invoke\\s*>`,
  'gu'
);

/**
 * A `calls` (or `tool_calls`) wrapper and everything up to its closing tag.
 *
 * The close tag is matched loosely on purpose: the live sample closed `<｜｜DSML｜｜ calls>`
 * with `</｜｜ calls>`, a different bar count. Requiring the two to agree would leave the
 * whole block in the text — the exact failure this rule exists to stop.
 */
const NAMELESS_ENVELOPE = new RegExp(
  `<${SEG}\\s*(?:tool_)?calls\\s*>([\\s\\S]*?)</${SEG}\\s*(?:tool_)?calls\\s*>`,
  'giu'
);

/**
 * Whether a block contains an `invoke` that names a tool.
 *
 * Deliberately stateless: this is asked once per envelope inside a loop, and a `g` regex
 * would answer differently on the second call. An opener is required — a lone `</invoke>`
 * does not make a block recoverable, and treating it as if it did is what let a live leak
 * through.
 */
const NAMED_INVOKE_ANYWHERE = new RegExp(`<${SEG}\\s*invoke\\s+name="`, 'iu');

/**
 * One `parameter …</parameter>` block inside an invoke, with its attributes.
 *
 * The word `parameter` is optional on the **opening** tag and mandatory on the closing
 * one. That asymmetry is not a guess: the live captures contain
 *
 *     <｜ name="command">Get-ChildItem …</｜｜DSML｜｜parameter>
 *
 * — the opener reduced to a delimiter and the attributes, the closer intact. Requiring
 * `parameter` on both ends matched nothing, so the call was recovered with `{}` and the
 * tool rejected it with `missing required property: command`. Ten of twenty-two calls in
 * one capture had that shape, and the model's response was to rewrite its own call four
 * different ways before reporting the harness as broken.
 *
 * The close tag still says `parameter`, which is what keeps this from matching arbitrary
 * `<x name="y">` prose: a `name=` attribute immediately after a bar delimiter, closed by a
 * bar-delimited `parameter`, is call syntax and nothing else.
 *
 * The attribute carrying the key drifts too. Besides `name="command"` the captures contain
 * `parameter="command"` — the tag's own word used as the attribute name — so the key is
 * read from `name`, `parameter`, or `key`, in that order.
 *
 * The word `parameter` is optional on the **closing** tag too, and that is the single most
 * expensive tolerance this parser needs. Measured on the real Qoder session
 * `session-87c61dd3` — 3,624KB of a live CyberWork conversation — the model closed parameters
 * with a bare `</｜｜DSML｜｜>` **3,151 times** against only 92 closes that spelled the word.
 * Requiring the word meant the close never matched: `[\s\S]*?` ran on to the next named close
 * or the end of the block, so the first parameter absorbed every following one. The captured
 * tool call from that session is the proof —
 *
 *     {"command": "ssh jp '… nproc'</｜｜DSML｜｜>\n<｜｜DSML｜｜ parameter name=\"description\" …
 *
 * — a `command` of 237 characters carrying the other two parameters as literal markup, which
 * the shell then rejected. The same miss, on a block with only one parameter, yielded `{}`,
 * which the host discarded as `EMPTY_RESPONSE` after telling the user the model "wrote call
 * syntax as text and none of it could be recovered". One regex, both symptoms.
 *
 * A bare close cannot be confused with the surrounding tags: `</｜｜DSML｜｜ invoke>` and
 * `</｜｜DSML｜｜ calls>` both have a word before the `>`, so the optional `parameter` is the
 * only thing that can appear in that position and the tag still closes.
 */
const PARAMETER = new RegExp(
  `<${SEG}\\s*(?:parameter\\s+)?(?:name|parameter|key)="([^"]*)"([^>]*)>([\\s\\S]*?)</${SEG}\\s*(?:parameter\\s*)?>`,
  'gu'
);

/**
 * An `invoke` opener, whether or not a closing tag ever follows it.
 *
 * Kept separate from {@link INVOKE} because the closing tag is the part the models drop:
 * the live captures contain a well-formed opener, both complete parameters, and then no
 * `</invoke>` at all — the model went into a repetition loop instead of closing. Matching
 * only closed blocks discarded a fully-specified call.
 */
const INVOKE_OPEN = new RegExp(`<${SEG}\\s*invoke\\s+name="([^"]*)"\\s*>`, 'gu');

/** Where an unclosed `invoke` body stops, if it does. */
const INVOKE_CLOSE = new RegExp(`</${SEG}\\s*invoke\\s*>|</\\s*invoke\\s*>`, 'u');

/** The enclosing `calls` wrapper and any stray closing tag. */
const NOISE = new RegExp(`</?${SEG}\\s*(?:calls|tool_calls)?\\s*>`, 'gu');

/**
 * A tag whose bar spelling is optional on either side.
 *
 * The second syntax family writes its closing tags with no bars at all: the live capture
 * has `<｜tool_name>pwsh</｜tool_name>` followed by `<command>…</command>` and a final
 * `</tool_response>`. Requiring a delimiter on the closing tag is what made that whole
 * block invisible — every tag in it is well-formed except that one detail.
 *
 * @param {string} name - a regex fragment, so alternation works.
 * @returns {string}
 */
function tag(name) {
  return `<${SEG}?\\s*(?:${name})\\s*>`;
}

/**
 * The name of the tool, as a child tag: `<…tool_name>pwsh</…tool_name>`.
 *
 * Both `tool_name` and the shorter `name` are live: the second is what the model copied
 * out of the prompt's own example when the first attempt failed.
 */
const ALT_NAME = `(?:tool_name|name)`;

/** An envelope around the second dialect, when the model bothers to write one. */
const ALT_ENVELOPE = new RegExp(
  `${tag('tool_call|tool_calls')}([\\s\\S]*?)</(?:${SEG})?\\s*(?:tool_call|tool_calls|tool_response)\\s*>`,
  'gu'
);

/** Where the second dialect's argument list stops when there is no envelope. */
const ALT_END = new RegExp(`</(?:${SEG})?\\s*(?:tool_call|tool_calls|tool_response)\\s*>`, 'u');

/** `<…argument name="command">…</…argument>`, the prompt's own spelling. */
const ALT_ARGUMENT = new RegExp(
  `<${SEG}?\\s*argument\\s+name="([^"]*)"([^>]*)>([\\s\\S]*?)</(?:${SEG})?\\s*argument\\s*>`,
  'gu'
);

/** `<…arguments>{json}</…arguments>`, which carries the whole object at once. */
const ALT_ARGUMENTS = new RegExp(`<${SEG}?\\s*arguments\\s*>([\\s\\S]*?)</(?:${SEG})?\\s*arguments\\s*>`, 'gu');

/** A parameter-less `<…tool_name>pwsh</…tool_name>` is a legal call. */
const ALT_NAME_ONLY = new RegExp(`${tag(ALT_NAME)}([\\s\\S]*?)</(?:${SEG})?\\s*${ALT_NAME}\\s*>`, 'u');

/** The same, for the passes that must hit every occurrence. */
const ALT_NAME_ALL = new RegExp(`${tag(ALT_NAME)}([\\s\\S]*?)</(?:${SEG})?\\s*${ALT_NAME}\\s*>`, 'gu');

/**
 * Reserved names that are structure rather than arguments, when scanning siblings.
 *
 * A sibling scan takes every `<k>v</k>` after the tool name as an argument, so the tags
 * that carry the structure itself have to be excluded or `tool_call` and `tool_name`
 * arrive at the tool schema as parameters.
 */
const ALT_RESERVED = new Set([
  'tool_call',
  'tool_calls',
  'tool_name',
  'tool_response',
  'argument',
  'arguments',
  'invoke',
  'parameter',
  'calls',
  'call',
  'name'
]);

/** `<command>…</command>` — a bare sibling pair, which needs no delimiter to be valid. */
const SIBLING = /<([A-Za-z_][\w$.-]*)\s*>([\s\S]*?)<\/\1\s*>/gu;

/**
 * The `invoke` keyword slid out of the tag name and into the attribute slot.
 *
 * Live, sixth round:
 *
 *   <｜｜｜｜call invoke="name">pwsh</｜｜DSML｜｜calls>
 *   <｜｜｜｜invoke name="command">Get-ChildItem -Force</｜｜DSML｜｜parameter>
 *   <｜｜｜｜invoke name="description">List files</｜｜DSML｜｜parameter>
 *
 * Read literally this is not a grammar — a `call` element whose `invoke` attribute is `name`,
 * and an `invoke` element carrying a `name` attribute. Read as a *displacement* it is the
 * ordinary form with one token shifted: `invoke name="pwsh"` became
 * `call invoke="name">pwsh`, and `parameter name="command"` became `invoke name="command"`.
 *
 * Both readings of the displaced attribute agree on the tool name — whether it is decoration
 * or a field label, the element's text is `pwsh` — which is why this is recoverable rather
 * than a guess.
 *
 * The guard is the displacement itself: the attribute key has to be one of the words the tag
 * name should have been (`invoke`, `function`, `tool_name`), so a well-formed
 * `<…invoke name="pwsh">` can never match {@link MISPLACED}. That matters because the two
 * forms are one token apart and both are live.
 */
const MISPLACED = new RegExp(
  `<${SEG}\\s*(?:call|calls)\\s+(?:invoke|function|tool_name)\\s*=\\s*"?\\s*(?:name|tool|function)\\s*"?\\s*>`
    + `\\s*([A-Za-z_$][\\w$.-]*)\\s*</(?:${SEG})?\\s*(?:call|calls|invoke)\\s*>`,
  'u'
);

/**
 * A parameter in the same displaced spelling: `<…invoke name="command">value</…parameter>`.
 *
 * The key is read from an attribute rather than from `parameter name=…` because in this
 * dialect the word that should have been the tag name is the one that moved.
 */
const MISPLACED_PARAMETER = new RegExp(
  `<${SEG}\\s*(?:invoke|parameter|argument)\\s+(?:name|key|parameter)\\s*=\\s*"([^"]+)"([^>]*)>`
    + `([\\s\\S]*?)</(?:${SEG})?\\s*(?:parameter|invoke|argument)\\s*>`,
  'gu'
);

/**
 * A tag-shaped fragment of the syntax that survived block removal.
 *
 * An envelope cut mid-call never matches {@link INVOKE}, so its opening tag is
 * left behind by the block passes; without this it reaches the screen as
 * `invoke name="pwsh">` — markup stripped of the one token that made it
 * recognisable. Bounded to a single line so a stray marker cannot eat prose.
 *
 * Two alternatives, and the second is not optional: a tag is either delimiter-led
 * (`<｜｜DSML｜｜parameter …>`, where the name may be missing because the marker was cut) or
 * name-only (`</tool_response>`), which the second dialect writes constantly. A bare
 * `<b>` matches neither, so prose inside a held block keeps its html.
 *
 * The terminator is `>` **or the end of the line**, and the second one is load-bearing.
 * A turn that degenerates into repeating a closing tag ends mid-tag — the captures contain
 * `</｜｜DSML｜parameter>` sixty times over, the last of them truncated to `</｜｜DSML｜` on its own
 * line. Requiring `>` left that tail in replayed history, which is the one place this
 * cleanup exists to keep the syntax out of: an assistant turn carrying markup comes back
 * as an example to copy. The line bound is what makes accepting a missing `>` safe — a
 * delimiter-led fragment with no closing bracket before the newline is markup, never prose.
 */
const RESIDUE = new RegExp(
  `</?(?:${SEG}\\s*(?:${TAG_NAMES.join('|')})?|(?:${TAG_NAMES.join('|')}))\\s*[^>\\n]*(?:>|(?=[\\r\\n]|$))`,
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
 * Detect the native token form on its own, without the DSML envelope.
 *
 * A model can emit these tokens with no `DSML` anywhere, and then nothing in
 * {@link MARKER} matches — the turn looks clean while the call sits on the screen as text.
 */
const NATIVE_PROBE = new RegExp(`${NATIVE_SEP}`, 'i');

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
  return (
    typeof value === 'string' &&
    (MARKER.test(value) || NATIVE_PROBE.test(value) || BARE_PROBE.test(value) || SPACED_TAG.test(value) || ANTHML_TAG.test(value))
  );
}

/**
 * Whether a string carries either call syntax.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasLeak(value) {
  if (typeof value !== 'string') return false;
  return (
    MARKER.test(value) ||
    NATIVE_PROBE.test(value) ||
    BARE_PROBE.test(value) ||
    SPACED_TAG.test(value) ||
    ANTHML_TAG.test(value) ||
    /\[tool call:/u.test(value)
  );
}

/**
 * Tag names a bare call can open or close with.
 *
 * Every rule that has to name a tag reads this list. It used to be spelled out three times
 * — in the probe, in the prefix test, and in the open-tag test — and the copies drifted.
 * The drift is invisible in batch parsing, because the rewriter handles the name anyway;
 * it only shows up when the same block is streamed one character at a time, where a name
 * missing from one list releases half a tag to the screen. `function_call` was recognised
 * by the rewriter and missing from the probe, so `<function_call name="pwsh">` was never
 * held, and `<function_call n` was released at the space.
 *
 * The cost is a one-chunk delay on HTML that shares a prefix — `<p` (`parameter`),
 * `<i` (`invoke`), `<code` (`calls`). It self-corrects as soon as the `>` arrives, and
 * it is the same trade the existing `<` hold already makes.
 */
const BARE_TAGS = ['invoke', 'parameter', 'calls', 'antml', 'function_call', 'function_calls', 'tool_call', 'tool_calls'];

/**
 * Every word that can begin a call tag, for the question "is this `<` an opener at all?".
 *
 * {@link BARE_TAGS} plus the delimiter word itself: `<｜｜DSML｜｜invoke` starts with `DSML`
 * after the bars, and a tag name list without it would call that opener ordinary text.
 */
const CALL_TAG_NAMES = [...BARE_TAGS, 'DSML'];

/**
 * The bare XML spelling of a call, with no delimiter bars at all.
 *
 * DeepSeek-family models normally write the native `<|DSML|invoke>` form, but some emit
 * plain `<invoke name="...">` markup instead — most often mixed into a native block, as
 * `<｜DSML｜ calls> <invoke name="pwsh">`, which is neither dialect on its own.
 *
 * Every pass below requires at least one bar, so those blocks bypassed recovery entirely:
 * `hasLeak` answered no, no block was held, and the markup was rendered to the screen as
 * prose while the tool never ran. Recovered from a live Qoder session, where the user
 * reported the call "not executing" and saw the tags instead.
 */
const BARE_PROBE = new RegExp(`<\\s*(?:${BARE_TAGS.join('|')})\\s+name\\s*=`, 'u');

/**
 * Whether a string is an unfinished bare tag name, with or without the closing slash.
 *
 * @param {string} body - text after the last `<`.
 * @returns {boolean}
 */
function isBareTagPrefix(body) {
  const name = body.startsWith('/') ? body.slice(1) : body;
  if (name.length === 0) return false;
  return BARE_TAGS.some((tag) => tag.startsWith(name));
}

/**
 * A bare tag that has been opened but whose `>` has not arrived.
 *
 * This has to be tested against the **raw** tail rather than the whitespace-stripped one
 * used above: stripping is right for the bar-delimited spelling, where the spaces are
 * decoration, and wrong here, where a space is what separates the tag name from its first
 * attribute. `<invoke n` collapses to `invoken`, which is not a prefix of any tag name, so
 * the stripped check released it — and the character-by-character stream then printed
 * `<invoke ` to the screen before `name=` could arrive. Caught by driving the real
 * `QoderConversation` with one-character deltas; the batch parser was never wrong.
 *
 * Holding until `>` is safe because `>` is what ends a tag. Once it lands, `hasNativeLeak`
 * takes over and the block is recovered as a whole.
 *
 * Built from {@link BARE_TAGS} rather than spelling the names again: the two lists drifted,
 * and the drift is invisible until a stream is fed one character at a time. `<function_call`
 * was in the prefix list but not here, so `<function_call n` — a space consumed, the tag
 * still open — was released and the tag reached the user in pieces.
 */
const BARE_TAG_OPEN = new RegExp(`^\\/?(?:${BARE_TAGS.join('|')})\\b[^>]*$`, 'u');

/**
 * Rewrite the bare spelling into the one-bar native form the rest of this module already
 * parses.
 *
 * One bar is a delimiter `SEG` accepts, so rewriting is enough: every downstream pass
 * (`INVOKE`, `INVOKE_OPEN`, `PARAMETER`, `NOISE`) then applies unchanged and there is no
 * second parser to keep in step with the first.
 *
 * Only tags carrying a `name=` attribute are rewritten. That is what keeps ordinary prose
 * about HTML out of it: `<invoke>`, `<parameter>` and `<calls>` without a name are left
 * exactly as written, because a sentence explaining the syntax must survive a round trip.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeBareTags(text) {
  return text
    // The name may be single-quoted or bare. A model that has been told to write `name="…"`
    // usually complies, but both alternatives appeared in the combination sweep, and the
    // quoted-only rule discarded the whole call when it drifted.
    .replace(/<invoke(\s+name\s*=\s*)(?:'([^']*)'|([A-Za-z_][\w.-]*))(\s*)>/gu,
      (_, lead, single, bare, tail) => `<|invoke${lead}"${single ?? bare}"${tail}>`)
    .replace(/<invoke(\s+name\s*=\s*"[^"]*"\s*)>/gu, '<|invoke$1>')
    .replace(/<\/invoke\s*>/gu, '</|invoke>')
    .replace(/<parameter(\s+name\s*=\s*)(?:'([^']*)'|([A-Za-z_][\w.-]*))([^>]*)>/gu,
      (_, lead, single, bare, tail) => `<|parameter${lead}"${single ?? bare}"${tail}>`)
    .replace(/<parameter(\s+name\s*=\s*"[^"]*"[^>]*)>/gu, '<|parameter$1>')
    .replace(/<\/parameter\s*>/gu, '</|parameter>')
    .replace(/<calls\s*>/gu, '<|calls>')
    .replace(/<\/calls\s*>/gu, '</|calls>')
    // Some models reach for `function_call` rather than `invoke`. Rewriting the name lets
    // the same parser handle it instead of adding a second dialect to keep in step.
    .replace(/<function_call([^>]*)>/gu, '<|invoke$1>')
    .replace(/<\/function_call\s*>/gu, '</|invoke>')
    .replace(/<\/?(?:function_calls)\s*>/gu, '<|calls>');
}

/**
 * Whitespace placed *inside* the markup, between `<` or `>` and a bar.
 *
 * Every tag regex here starts `<${SEG}`, so a single space after the `<` made the whole
 * block invisible: `< ｜｜DSML｜｜ calls>` matched nothing, `hasLeak` said no, and the block
 * was streamed to the screen exactly as written. A model that formats its output loosely
 * — or that re-indents after a long argument — produces this shape readily.
 *
 * The closing tags carry the same defect and it is *more* common there: `</ ｜｜DSML｜｜parameter>`
 * puts the space between the slash and the bars, where `<(\s+)(?=\uFF5C)` cannot see it
 * because the slash sits in between. Every close regex begins `</${SEG}`, so all of them
 * missed, and the closing tags were left behind in the text channel while the call itself
 * was recovered — the block read as a call followed by its own source. Measured over the
 * spelling combinations: 68% of failures came from this one space.
 *
 * Only the fullwidth bar is treated this way. `|` is ordinary punctuation in prose and a
 * table row reading `| value > x` must not be rewritten. The one exception is an ASCII run
 * followed by the word `DSML`, where the intent cannot be anything else.
 */
const SPACED_TAG = new RegExp(
  [
    // The fullwidth bar is unambiguous on its own.
    '<\\s+\\uFF5C',
    '<\\/\\s+\\uFF5C',
    '\\uFF5C\\s+>',
    '\\uFF5C\\s+\\uFF5C',
    // An ASCII bar is only a delimiter when `DSML` follows it. Without that guard this
    // matched `if (a < |b|) {}` — ordinary arithmetic — and the sweep's fix for loosely
    // spaced markup started reporting prose as a call.
    '<\\s+[\\uFF5C|]{1,32}\\s*DSML',
    '<\\/\\s+[\\uFF5C|]{1,32}\\s*DSML',
    // No delimiter at all, but a tag name right where one would go.
    '<\\s+\\/?(?:invoke|parameter|calls|antml)\\b'
  ].join('|'),
  'iu'
);

/** One bar, either spelling. */
const BAR = '[\\uFF5C|]';

/**
 * `<\s+BARRUN\s*DSML` — a delimiter written with a space in front of it.
 *
 * The bar run is spelled with both characters because the model mixes them: `|｜DSML｜|`
 * appeared in the combination sweep and defeated a lookahead that only accepted the
 * fullwidth bar. Requiring `DSML` to follow is what keeps prose safe — a sentence opening
 * `< |a| >` is arithmetic, not a call.
 */
const SPACED_DELIMITER = new RegExp(`<(\\s+)(?=${BAR}{1,32}\\s*DSML)`, 'giu');
const SPACED_DELIMITER_CLOSE = new RegExp(`<\\/(\\s+)(?=${BAR}{1,32}\\s*DSML)`, 'giu');

/** `@param {string} text @returns {string} */
function normalizeSpacedTags(text) {
  return text
    // Closers first, and unconditionally on the bar spelling: `</` followed by a bar and
    // a space is not something prose produces, and it appears with bare bars (`</ ｜｜parameter>`)
    // where no `DSML` word exists to key on. The opener rule below stays guarded, because
    // `< |` at the start of an arithmetic aside is ordinary text.
    .replace(/<\/(\s+)(?=[\uFF5C|])/gu, '</')
    .replace(SPACED_DELIMITER_CLOSE, '</')
    .replace(SPACED_DELIMITER, '<')
    .replace(/<(\s+)(?=\uFF5C)/gu, '<')
    .replace(/([\uFF5C|])(\s+)>/gu, '$1>')
    .replace(/(\uFF5C)\s+(\uFF5C)/gu, '$1$2')
    // No delimiter at all: `< invoke name="pwsh">`. The tag name is the only thing after
    // the space, so nothing else can be meant.
    .replace(/<(\s+)(?=\/?(?:invoke|parameter|calls|antml)\b)/giu, '<')
    // The same, on the closing side with no bars at all: `</ parameter>`.
    .replace(/<\/(\s+)(?=\/?(?:invoke|parameter|calls|function_call)\b)/giu, '</');
}

/**
 * Anthropic's `antml:` call spelling, rewritten into the form parsed below.
 *
 * This is not a hypothetical dialect: the injected system prompt opens by telling the
 * model to start its thinking with `antmlThinking`, which primes the whole `antml:` family.
 * Nothing in this module recognised it, so `hasLeak` returned false and such a block was
 * never even held — it streamed to the screen untouched.
 */
const ANTHML_TAG = /<\s*\/?\s*antml:/iu;

/** @param {string} text @returns {string} */
function normalizeAnthropicTags(text) {
  return text
    .replace(/<\s*antml:(?:invoke|function_call)\s+name\s*=\s*"([^"]*)"([^>]*)>/giu, '<|invoke name="$1"$2>')
    .replace(/<\s*\/\s*antml:(?:invoke|function_call)\s*>/giu, '</|invoke>')
    .replace(/<\s*antml:parameter\s+name\s*=\s*"([^"]*)"([^>]*)>/giu, '<|parameter name="$1"$2>')
    .replace(/<\s*\/\s*antml:parameter\s*>/giu, '</|parameter>')
    .replace(/<\s*\/?\s*antml:(?:function_calls|calls)\s*>/giu, '<|calls>');
}

/**
 * One tag doing double duty: closing a parameter and opening the next.
 *
 * The live Qoder session contains
 *
 *     …20261027-fofa-idle-batch.sh</｜｜DSML｜｜ parameter name="old_string">  echo "…
 *
 * — a `file_path` value that ends in a close tag which immediately carries the *next*
 * parameter's attributes. No closing-tag rule can match it, because the tag is not a close and
 * not an open: it is both at once. Exactly eight of the 258 tool calls in `session-87c61dd3`
 * carry this shape, and the effect is the same as the bare-close defect — the value absorbs the
 * following parameter as literal markup, so the tool receives a filename with tags stuck to it.
 *
 * Splitting the tag in two is a rewrite, not a new grammar: the parser already understands
 * `</X><X parameter …>`, so this only says out loud what the model meant. The lookahead keeps it
 * off real closes — `parameter>` has no attribute after it, so a plain `</… parameter>` is left
 * alone.
 */
const CLOSE_TAG_AS_OPENER = /<\/(\s*[\uFF5C|][^<>]{0,24}?)\s+parameter\s+(?=(?:name|parameter|key)\s*[=:])/giu;

/** @param {string} text @returns {string} */
function normalizeCloseAsOpener(text) {
  return text.replace(CLOSE_TAG_AS_OPENER, '</$1><$1 parameter ');
}

/**
 * Rewrite every tolerated spelling into the one-bar native form.
 *
 * Order matters: Anthropic tags first (they carry their own `<antml:` prefix), then the
 * close-as-opener split, then the whitespace defects, then the bare XML names — the last step
 * assumes `<` and the tag name are already adjacent. The split runs before the spacing passes
 * because the later ones tighten what is around the bars, and the shape is easier to recognise
 * while the model's own spacing is still intact.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeCallSyntax(text) {
  return normalizeBareTags(normalizeSpacedTags(normalizeAnthropicTags(normalizeCloseAsOpener(text))));
}

/**
 * Whether a call block has been opened but not closed.
 *
 * Needed by the channels that hold instead of parse. The text channel decides "the block is
 * still arriving" by trying to recover calls from it, but the reasoning channel never
 * recovers anything — it only strips — so it had no such test and stripped each delta the
 * moment `hasLeak` turned true. That is the defect this exists to fix: a block that arrives
 * in pieces has its opening removed by the first strip, and the remaining pieces, now
 * carrying no recognisable open tag, are emitted as prose. The user sees
 * `｜｜invoke name="pwsh">｜｜parameter name="command">Get-Date` in the thinking pane.
 *
 * Counting is done after {@link normalizeCallSyntax}, so every tolerated spelling — bare
 * tags, `antml:`, loose spacing, any bar count — has already become the one-bar form and a
 * single pair of patterns covers all of them. Deriving from that normalization rather than
 * spelling the tag names again is deliberate: this file has already been bitten by one list
 * of names drifting from another.
 *
 * A stray `<|` in genuine prose counts as an opener and delays its own release by one
 * chunk. That is the same self-correcting trade the marker hold already makes.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasUnclosedCallMarkup(value) {
  const text = typeof value === 'string' ? value : '';
  if (text.length === 0) return false;
  // A tag that has begun but has no `>` yet cannot be judged finished either way. This
  // arm is not redundant with the counts below: `normalizeCallSyntax` only rewrites tags it
  // can see the end of, so an opener still in flight is left in its original spelling and
  // the counts would read it as zero opens.
  if (text.lastIndexOf('<') > text.lastIndexOf('>')) return true;
  const normalized = normalizeCallSyntax(text);
  // Both bar spellings. The normalizer emits the fullwidth bar, so a pattern written with
  // the ASCII one matches nothing at all — which is exactly how this function first landed
  // with a permanent `false` and let the leak it was written to stop continue.
  const opens = (normalized.match(/<(?!\/)[\uFF5C|]/gu) ?? []).length;
  const closes = (normalized.match(/<\/[\uFF5C|]/gu) ?? []).length;
  return opens > closes;
}

/**
 * Drop a marker that is still open at the end of a stream, keeping the prose before it.
 *
 * {@link stripLeak} removes markers it can see the end of, which is right for history — a
 * half-written form there is more likely prose *about* the syntax than a truncated call. At
 * the end of a turn the opposite is true: a block that never closed is a call the model
 * failed to finish, and there is nothing to recover, so showing it leaks the wire format.
 * Measured: a reasoning channel released `[tool call: pwsh {"command":"Get-D` when the turn
 * ended mid-block, and `stripLeak` had left it alone on purpose.
 *
 * Three shapes have to be cut, and they nest, so the walk is a depth count rather than a
 * search for the last known pattern:
 *
 *   - `[tool call: …` with no `]`,
 *   - a delimited block whose close tag never arrived,
 *   - an opening tag whose `>` never arrived.
 *
 * Cutting starts at the outermost unclosed opener, so prose that *preceded* the block is
 * kept — that text is the model's own answer.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function truncateOpenMarkup(value) {
  let text = typeof value === 'string' ? value : '';
  if (text.length === 0) return text;

  const bracket = /\[tool call:[^\]]*$/u.exec(text);
  if (bracket !== null) text = text.slice(0, bracket.index);
  if (text.length === 0) return text;

  // Every delimited tag that has both angle brackets. Count nesting so the cut lands at the
  // outermost opener rather than at whichever tag happened to be last. The recognised tag
  // names come from the same list the rest of the module uses: a pattern that only knew
  // about bars left `<invoke name="pwsh"><parameter …>` uncut, which is the bare spelling
  // this file exists to support.
  const tagPattern = new RegExp(`<\\/?[^>]*?(?:[\\uFF5C|]|(?:${BARE_TAGS.join('|')})\\b)[^>]*>`, 'gu');
  let depth = 0;
  let outer = -1;
  for (const match of text.matchAll(tagPattern)) {
    if (match[0].startsWith('</')) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) outer = -1;
    } else {
      if (depth === 0) outer = match.index;
      depth += 1;
    }
  }
  if (depth > 0 && outer >= 0) text = text.slice(0, outer);
  if (text.length === 0) return text;

  // A tag that never even reached its `>`.
  //
  // This used to cut at the last `<` unconditionally, which destroyed ordinary answers: a
  // reply saying `If x < y then swap them.` came out as `If x `. Anything a model writes about
  // comparison, ranges or code contains `<`, so the unconditional form silently deleted the
  // second half of a great many correct answers — a certain loss of content traded for an
  // occasional display glitch, which is the wrong way round.
  //
  // So the `<` is only treated as an opener if what follows could still turn into a call tag.
  // `y`, `10`, `n` cannot; `tool_call`, `antml`, `｜｜` can. The test is on the *shape* of the
  // remainder, which is what makes `<to` cut (it could become `tool_call`) while `< y` does
  // not.
  const lastOpen = text.lastIndexOf('<');
  if (lastOpen > text.lastIndexOf('>') && startsCallMarkup(text.slice(lastOpen + 1))) {
    text = text.slice(0, lastOpen);
  }
  return text;
}

/**
 * Whether what follows a `<` could be the beginning of a call tag.
 *
 * The bar forms are unambiguous, so they are accepted on sight. The bare forms are not: a
 * tag name is an ordinary English word often enough that a prefix test deletes real prose.
 * `value < tool` is a sentence, and `< tool_call` is a truncated tag; both are four letters
 * after the `<`, so no amount of lookahead separates them.
 *
 * The tie breaks toward keeping the text, because the two mistakes are not equally bad. A
 * tag that survives here is a few characters of debris at the very end of one turn; prose
 * deleted here is a correct answer silently cut in half. So only a *complete* tag name counts
 * — `tool_call`, `antml`, `invoke` — and `<to` or `<tool` is left as the text it probably is.
 *
 * @param {string} after - the text following the `<`.
 * @returns {boolean}
 */
function startsCallMarkup(after) {
  let rest = after.replace(/^\s+/u, '');
  // `<` alone: nothing has arrived yet, so it may still become anything.
  if (rest.length === 0) return true;
  // A bar is already specific to this wire format, ASCII or fullwidth.
  if (/^[\uFF5C|]/u.test(rest)) return true;
  if (rest.startsWith('/')) {
    rest = rest.slice(1).replace(/^\s+/u, '');
    if (rest.length === 0) return true;
    if (/^[\uFF5C|]/u.test(rest)) return true;
  }
  const lowered = rest.toLowerCase();
  return CALL_TAG_NAMES.some((tag) => {
    const name = tag.toLowerCase();
    if (!lowered.startsWith(name)) return false;
    // The name has to be complete: what follows it must not continue the word.
    const next = lowered.charAt(name.length);
    return next === '' || next === ' ' || next === '\t' || next === '/' || next === '>';
  });
}

/**
 * Names that only appear when the model copies the instruction's template instead of
 * filling it in.
 *
 * The tool preamble spells the shape out as `<invoke name="TOOL_NAME">` with a
 * `PARAMETER_NAME` parameter, and a weak model sometimes reproduces it literally. Recovery
 * happily turned that into a call for a tool named `TOOL_NAME`, which the harness then
 * rejected as unknown — a visible failure where the model had not actually asked to run
 * anything. Recognising the placeholders keeps the block out of both channels.
 */
const PLACEHOLDER_NAMES = new Set(['TOOL_NAME', 'TOOLNAME', 'PARAMETER_NAME', 'PARAMNAME', 'PARAMETER', 'VALUE', 'NAME', 'TOOL']);

/** @param {unknown} name @returns {boolean} */
function isPlaceholderName(name) {
  return PLACEHOLDER_NAMES.has(String(name ?? '').trim().toUpperCase());
}

/**
 * Tag names that can follow a delimiter.
 *
 * A held tail is only released once it cannot be the start of one of these, which
 * is what keeps `<｜｜DSML｜｜` from being printed as text the instant the delimiter
 * completes. It is also what keeps the bare bar spelling from matching prose: the
 * lookahead in {@link MARKER} accepts a bare run of bars only ahead of one of these.
 */

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

  // The same tail with its whitespace intact, for the one rule that needs to tell a tag
  // name from the attribute after it.
  const rawTail = value.slice(-MARKER_MAX).replace(/[\uFF5C]/gu, '|');
  const rawAt = rawTail.lastIndexOf('<');
  const rawBody = rawAt < 0 ? '' : rawTail.slice(rawAt + 1);

  // Still typing the delimiter itself: `<`, then any run of bars.
  if (body.length === 0) return true;
  // `< ` on its way to `< ｜｜DSML｜｜`, and the same at the closing end. The bar runs may
  // also arrive split, so a tail of nothing but spaces and bars is still undecided.
  if (/^[|\s]*$/u.test(body)) return true;
  // Anthropic's spelling, character by character: `<antml:` then the tag name.
  if (/^\/?\s*antml:?[a-z_]*$/iu.test(rawBody)) return true;
  // The bare XML spelling arriving one character at a time. `<` alone already holds
  // above; this extends that to `<inv`, `<param` and the closing forms.
  if (isBareTagPrefix(body)) return true;
  // A bare tag already opened but not yet closed. Asked of the raw tail, because the
  // whitespace-stripped one merges `<invoke n` into `invoken` and releases it.
  if (BARE_TAG_OPEN.test(rawBody)) return true;
  if (/^\|{1,32}$/u.test(body)) return true;
  // The letters arriving one at a time after the opening bars.
  if (/^\|{1,32}D?(?:S(?:M(?:L)?)?)?$/u.test(body)) return true;
  // The delimiter is complete; hold until a tag name rules it out, because a
  // released delimiter reaches the screen as `<｜｜DSML｜｜` with no context.
  if (/^\|{1,32}DSML\|{0,32}$/u.test(body)) return true;
  // A word arriving before `DSML`: `<｜tool` on its way to `<｜toolDSML｜｜`.
  if (/^\|{1,32}[A-Za-z_]{1,12}$/u.test(body)) return true;
  if (/^\|{1,32}[A-Za-z_]{0,12}D?(?:S(?:M(?:L)?)?)?$/u.test(body)) return true;
  // The native control tokens, arriving one character at a time:
  // `<｜｜｜▁beg`, `<｜tool▁se`, and the trailing bar before the `>`.
  if (/^\|{1,32}[\u2581_]{1,4}$/u.test(body)) return true;
  if (/^\|{1,32}[\u2581_]*[A-Za-z_]{1,16}[\u2581_]{0,4}$/u.test(body)) return true;
  if (/^\|{1,32}[\u2581_]*[A-Za-z_]{1,16}[\u2581_]*\|{0,32}$/u.test(body)) return true;

  const opened = /^(?:\|{1,32}[A-Za-z_]{0,12}DSML\|{0,32}|\|{1,32})([A-Za-z_]*)$/u.exec(body);
  if (opened !== null) {
    const after = opened[1].toLowerCase();
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
 * Recover the calls the second dialect was trying to make.
 *
 * The shape the models invent when the DSML envelope appears not to work:
 *
 *     <｜tool_call>
 *     <name>pwsh</name>
 *     <arguments>{"command": "…"}</arguments>
 *     </tool_call>
 *
 * and its flatter cousin, which is what the live captures end with once the model has
 * given up on the envelope entirely:
 *
 *     <｜tool_name>pwsh</｜tool_name>
 *     <command>…</command>
 *     <description>…</description>
 *     </tool_response>
 *
 * The tool name is the anchor, because both shapes have it. Everything after it, up to
 * the end of the envelope or the next `</tool_response>`, is argument material: an
 * `<arguments>` JSON child, `<argument name="k">` children, or bare `<k>v</k>` siblings.
 *
 * The spans come back with the calls so the caller can remove exactly what was read. A
 * sibling scan that guesses at the block's extent leaves half of it behind in the
 * transcript, which is what the first attempt at this did.
 *
 * @param {string} value
 * @returns {{calls: {name: string, arguments: string}[], spans: [number, number][]}}
 */
function parseAlternateCalls(value) {
  const calls = [];
  const spans = [];
  for (const envelope of value.matchAll(ALT_ENVELOPE)) {
    const body = envelope[1];
    const named = ALT_NAME_ONLY.exec(body);
    if (named === null) continue;
    const name = stripLeak(named[1]).trim();
    if (!NAME_OK.test(name)) continue;
    const after = body.slice(named.index + named[0].length);
    spans.push([envelope.index, envelope.index + envelope[0].length]);
    calls.push({ name, arguments: JSON.stringify(alternateArguments(after)) });
  }
  if (calls.length > 0) return { calls, spans };

  // No envelope. Anchor on the first tool name tag and take the rest of the block.
  const opened = ALT_NAME_ONLY.exec(value);
  if (opened === null) return { calls, spans };
  const name = stripLeak(opened[1]).trim();
  if (!NAME_OK.test(name)) return { calls, spans };
  const bodyStart = opened.index + opened[0].length;
  let after = value.slice(bodyStart);
  const end = ALT_END.exec(after);
  const bodyEnd = end === null ? value.length : bodyStart + end.index + end[0].length;
  if (end !== null) after = after.slice(0, end.index);
  spans.push([opened.index, bodyEnd]);
  calls.push({ name, arguments: JSON.stringify(alternateArguments(after)) });
  return { calls, spans };
}

/**
 * Read the displacement dialect: `call invoke="name">TOOL` plus `invoke name="KEY">VALUE`.
 *
 * Emits nothing unless at least one parameter was found. A tool name on its own never said
 * what to run, and answering with `{}` is the F-012 failure one dialect further out — the
 * model sees its call "arrive" with the arguments stripped, retries, and eventually reports
 * the harness as broken.
 *
 * @param {string} value
 * @returns {{calls: {name: string, arguments: string}[], spans: [number, number][]}}
 */
function parseMisplacedCalls(value) {
  const declared = MISPLACED.exec(value);
  if (declared === null) return { calls: [], spans: [] };
  const name = declared[1].trim();
  if (!NAME_OK.test(name)) return { calls: [], spans: [] };

  const spans = [[declared.index, declared.index + declared[0].length]];
  const properties = {};
  const bodyStart = declared.index + declared[0].length;
  for (const parameter of value.slice(bodyStart).matchAll(MISPLACED_PARAMETER)) {
    const key = parameter[1].trim();
    if (key.length === 0) continue;
    const identity = parameterIdentity(key, parameter[2]);
    properties[identity.name] = coerce(parameter[3], identity.attributes);
    spans.push([bodyStart + parameter.index, bodyStart + parameter.index + parameter[0].length]);
  }
  if (Object.keys(properties).length === 0) return { calls: [], spans };

  return { calls: [{ name, arguments: JSON.stringify(properties) }], spans };
}

/**
 * Read an argument object out of the text that follows a tool name.
 *
 * Three spellings, tried in order of how explicit they are. A malformed `<arguments>`
 * JSON body falls through to the tag scans rather than failing outright, because a model
 * that got the JSON slightly wrong still wrote the parameters out by name.
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function alternateArguments(text) {
  const properties = {};

  for (const match of text.matchAll(ALT_ARGUMENTS)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(properties, parsed);
      }
    } catch {
      /* the tags below may still carry the same values */
    }
  }

  for (const match of text.matchAll(ALT_ARGUMENT)) {
    const identity = parameterIdentity(match[1], match[2]);
    if (!NAME_OK.test(identity.name)) continue;
    properties[identity.name] = coerce(match[3], identity.attributes);
  }

  for (const match of text.matchAll(SIBLING)) {
    const key = match[1];
    if (ALT_RESERVED.has(key) || !NAME_OK.test(key)) continue;
    if (Object.hasOwn(properties, key)) continue;
    properties[key] = coerce(match[2], '');
  }

  return unwrapArguments(properties);
}

/**
 * Names a model uses for "the arguments" rather than for an argument.
 *
 * Live: `<tool_name>pwsh</tool_name><args><command>…</command><description>…</description></args>`.
 * The sibling scan saw an element called `args` and read it as a parameter whose value was
 * the inner tags *as text*, so the call went out with one argument nobody's schema declares,
 * the tool answered `required property 'command' is missing`, and the model retried in four
 * formats while deciding the harness was broken. That is F-012 again, one wrapper out.
 */
const ARGUMENT_WRAPPERS = new Set(['args', 'arguments', 'parameters', 'params', 'input', 'kwargs']);

/**
 * Replace a sole wrapper property with the properties it wraps.
 *
 * Two conditions, both required, because the unwrap is destructive:
 *
 * 1. the wrapper is the **only** property — a call that already carries `command` beside an
 *    `args` element is not a wrapped call, it is a call with an odd extra argument;
 * 2. the value looks like a bag — either `<key>value</key>` pairs or a JSON object. A plain
 *    string is a genuine argument: `docker_run` really does take `args` as text.
 *
 * @param {Record<string, unknown>} properties
 * @returns {Record<string, unknown>}
 */
function unwrapArguments(properties) {
  const keys = Object.keys(properties);
  if (keys.length !== 1) return properties;
  if (!ARGUMENT_WRAPPERS.has(keys[0])) return properties;
  const value = properties[keys[0]];
  if (typeof value !== 'string') return properties;

  const inner = {};
  for (const match of value.matchAll(SIBLING)) {
    const key = match[1];
    if (ALT_RESERVED.has(key) || !NAME_OK.test(key)) continue;
    if (Object.hasOwn(inner, key)) continue;
    inner[key] = coerce(match[2], '');
  }
  if (Object.keys(inner).length > 0) return inner;

  try {
    const parsed = JSON.parse(value.trim());
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ...parsed };
  } catch {
    /* not a JSON bag either: the wrapper is a plain argument after all */
  }
  return properties;
}

/**
 * Every span that is markup rather than prose, merged, and cut out in one pass.
 *
 * Removing markup with a chain of `replace()` calls is what left `<command>` tags in the
 * transcript: each pass only knows its own pattern, so a tag whose shape was not one of
 * them survived. Collecting the spans first makes the set of removals explicit and lets a
 * caller report exactly what it consumed.
 *
 * @param {string} value
 * @param {readonly (readonly [number, number])[]} spans - `[start, end)` offsets.
 * @returns {string}
 */
function cutSpans(value, spans) {
  if (spans.length === 0) return value;
  const sorted = [...spans].sort((left, right) => left[0] - right[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of sorted) {
    if (end <= at) continue;
    if (start > at) out += value.slice(at, start);
    at = end;
  }
  return out + value.slice(at);
}

/**
 * Recover the calls a leaked block was trying to make.
 *
 * @param {unknown} value - assistant text that contains the native syntax.
 * @returns {{calls: {name: string, arguments: string}[], rest: string, leaked: boolean,
 *   degenerate: boolean}} `calls` in the order they appear; `rest` is the text that was
 *   not markup; `degenerate` says the block was a repetition loop with no call in it.
 */
export function parseLeakedCalls(value) {
  // Every tolerated spelling is rewritten first, so a single parser covers all of them.
  if (typeof value === 'string') value = normalizeCallSyntax(value);
  if (typeof value !== 'string' || !hasLeak(value)) {
    return {
      calls: [],
      rest: typeof value === 'string' ? value : '',
      leaked: false,
      degenerate: isDegenerate(value)
    };
  }

  const calls = [];
  /** `[start, end)` of every match that has been turned into a call or is plain markup. */
  const spans = [];
  for (const invoke of value.matchAll(INVOKE)) {
    const name = invoke[1].trim();
    if (name.length === 0) continue;
    spans.push([invoke.index, invoke.index + invoke[0].length]);
    calls.push({ name, arguments: JSON.stringify(parametersOf(invoke[2])) });
  }

  // An `invoke` whose closing tag never arrived.
  //
  // This is not a rare corruption: the live captures end without one. The model writes
  // the opening tag, both complete parameters, and then degenerates instead of closing
  // the envelope — so the call in front of it is whole while the block that would have
  // matched it is not. Requiring the closing tag threw away a fully-specified call.
  //
  // A parameter has to be present for this to count. An opener on its own is a turn that
  // was cut off before it said anything, and inventing `{}` there would run a tool the
  // model had not yet asked for.
  for (const open of value.matchAll(INVOKE_OPEN)) {
    if (spans.some(([start, end]) => open.index >= start && open.index < end)) continue;
    const name = open[1].trim();
    if (name.length === 0) continue;
    const bodyStart = open.index + open[0].length;
    const close = INVOKE_CLOSE.exec(value.slice(bodyStart));
    const bodyEnd = close === null ? value.length : bodyStart + close.index;
    const properties = parametersOf(value.slice(bodyStart, bodyEnd));
    if (Object.keys(properties).length === 0) continue;
    spans.push([open.index, close === null ? value.length : bodyEnd + close[0].length]);
    calls.push({ name, arguments: JSON.stringify(properties) });
  }

  // The rendered form, when the model copied this plugin's own flattening.
  for (const rendered of value.matchAll(RENDERED)) {
    const name = rendered[1].trim();
    if (name.length === 0) continue;
    const raw = (rendered[2] ?? '').trim();
    if (raw === '') {
      spans.push([rendered.index, rendered.index + rendered[0].length]);
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
    spans.push([rendered.index, rendered.index + rendered[0].length]);
    calls.push({ name, arguments: argumentsJson });
  }

  // The tokenizer's own control tokens: `begin` … `function` … `sep` … name … `end`.
  // Read before the alternate dialect because it is unambiguous — the sequence only exists
  // as a function call — and because its argument fence gives a complete bag outright.
  for (const native of value.matchAll(NATIVE_CALL)) {
    const name = native[1].trim();
    if (name.length === 0) continue;
    const fenced = ARGUMENT_FENCE.exec(native[2]);
    // No fence, or a fence holding something that is not an object: the block is still
    // markup and must not reach the screen, but no call is invented from it. `{}` here
    // would run a tool the model had not finished describing.
    const span = [native.index, native.index + native[0].length];
    if (fenced === null) {
      spans.push(span);
      continue;
    }
    let argumentsJson;
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        spans.push(span);
        continue;
      }
      argumentsJson = JSON.stringify(parsed);
    } catch {
      spans.push(span);
      continue;
    }
    spans.push(span);
    calls.push({ name, arguments: argumentsJson });
  }

  // The displacement dialect, when the tool name is spelled as a `call` element with the
  // `invoke` keyword in attribute position. Only reached when nothing else produced a call:
  // its parameters use the same tag names as the canonical form, so running it beside a
  // successful `invoke` parse would emit a second call for the same intent.
  if (calls.length === 0) {
    const displaced = parseMisplacedCalls(value);
    calls.push(...displaced.calls);
    spans.push(...displaced.spans);
  }

  // The second dialect, only when the first one produced nothing: a block that already
  // yielded an `invoke` call has one call in it, and reading its wrapper tags as a second
  // call would execute the same intent twice.
  if (calls.length === 0) {
    const alternate = parseAlternateCalls(value);
    calls.push(...alternate.calls);
    spans.push(...alternate.spans);
  }

  // Everything that is not markup survives as text; an incomplete block (a
  // stream that was cut mid-call) is noise, not text, so it goes too.
  const rest = cutSpans(value, [...spans, ...residualSpans(value)]).trim();

  // A call named after the template's own placeholder was not a request to run anything:
  // the model reproduced the instruction instead of following it. Its span is already cut
  // out above, so dropping the call leaves nothing behind on either channel — the turn
  // reads as empty, which the host retries, rather than as a call to a tool that does not
  // exist, which the host rejects with an error the user can do nothing about.
  if (calls.some((call) => isPlaceholderName(call.name))) {
    const usable = calls.filter((call) => !isPlaceholderName(call.name));
    return { calls: usable, rest: usable.length === 0 ? '' : rest, leaked: true, degenerate: isDegenerate(value) };
  }

  return { calls, rest, leaked: true, degenerate: isDegenerate(value) };
}

/**
 * Read the parameters of one `<…invoke>` body.
 *
 * A parameter-less tool is legal: `npm_test` takes nothing.
 *
 * The wrapper unwrap applies here too: `<parameter name="args">` with `<command>` inside is
 * the same mistake as the tag-based dialects' `<args>` element, and it was measured on live
 * frames before it was reported — a call that arrives with an argument nobody's schema
 * declares reads to the user as "the plugin lost my arguments".
 *
 * @param {string} body
 * @returns {Record<string, unknown>}
 */
function parametersOf(body) {
  const properties = {};
  for (const parameter of body.matchAll(PARAMETER)) {
    const key = parameter[1].trim();
    if (key.length === 0) continue;
    const identity = parameterIdentity(key, parameter[2]);
    properties[identity.name] = coerce(parameter[3], identity.attributes);
  }
  // The reserved-token dialect writes its arguments without closing tags, so it is collected on
  // its own passes rather than folded into `PARAMETER`. A name already taken by a well-formed
  // `</parameter>` wins: that is the shape the model wrote most deliberately.
  //
  // Order matters. `SEPARATOR_CLOSED_PARAMETER` runs first because it owns the *first* argument of
  // such a block, whose value ends where the `<|open|>argument …` run begins; running
  // `SEPARATED_ARGUMENT` first would leave that opener unconsumed and the value would pick it up.
  for (const argument of body.matchAll(SEPARATOR_CLOSED_PARAMETER)) {
    const key = parameterIdentity(argument[1].trim(), argument[2]);
    if (key.name.length === 0) continue;
    if (Object.hasOwn(properties, key.name)) continue;
    properties[key.name] = coerce(argument[3], key.attributes);
  }
  for (const argument of body.matchAll(SEPARATED_ARGUMENT)) {
    const key = parameterIdentity(argument[1].trim(), argument[2]);
    if (key.name.length === 0) continue;
    if (Object.hasOwn(properties, key.name)) continue;
    properties[key.name] = coerce(argument[3], key.attributes);
  }
  return unwrapArguments(properties);
}

/**
 * Whole envelopes that name no tool, and are therefore markup rather than text.
 *
 * A model sometimes writes the outer `calls` wrapper and the parameters, and never writes
 * the `invoke` that carries the tool name:
 *
 *     <｜｜DSML｜｜ calls> <｜｜DSML｜｜ parameter name="command">…</｜｜DSML｜｜> … </｜｜DSML｜｜ calls>
 *
 * There is no name in that fragment — the only `name=` attributes are parameter keys — so
 * it cannot be turned back into a call: guessing `pwsh` from a `command` parameter would
 * run a tool the model never asked for. It is still markup, though, and what it wraps is a
 * shell heredoc. Left alone, the wrapper tags were stripped by the residue passes while the
 * body between them survived as prose, so the user was shown the raw here-string — reported
 * from a live Qoder session, twice in one conversation.
 *
 * A block only counts when it is closed: an unterminated `calls` opener is a stream that
 * was cut off, and deleting everything after it would throw away the text that follows in
 * a still-building turn. The name check is what keeps a legitimate `calls` wrapper — one
 * that does contain an `invoke` — out of this pass, because that one has already been
 * recovered by its own rule above.
 *
 * @param {string} value
 * @returns {[number, number][]}
 */
function namelessEnvelopeSpans(value) {
  const spans = [];
  for (const envelope of value.matchAll(NAMELESS_ENVELOPE)) {
    const body = envelope[1] ?? '';
    // Recovered already, by `INVOKE` or a dialect: leave those spans to their own rules.
    //
    // The test is an `invoke` that **carries a name**, not the word `invoke`. A block can
    // end with `</invoke>` and never have opened one — reported live, after the first
    // version of this rule matched on the bare word and let the block through untouched,
    // because the closing tag it was written with satisfied the check.
    //
    // `NAMED_INVOKE_ANYWHERE` rather than `INVOKE_OPEN`: the latter is global, and `.test()`
    // on a global regex advances `lastIndex`, so the second envelope in one string would be
    // judged by whatever the first one left behind.
    if (NAMED_INVOKE_ANYWHERE.test(body)) continue;
    spans.push([envelope.index, envelope.index + envelope[0].length]);
  }
  return spans;
}

/**
 * Every span the generic cleanup passes would remove.
 *
 * @param {string} value
 * @returns {[number, number][]}
 */
function residualSpans(value) {
  const spans = [...namelessEnvelopeSpans(value)];
  for (const pattern of [NOISE, RESIDUE, MARKER_ALL, RUNAWAY_ALL]) {
    for (const match of value.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
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
  // Normalised first for the same reason as in parseLeakedCalls: the rewrite puts the
  // block into a spelling the deletion passes below already recognise, so the whole
  // call is cut instead of leaving its argument values behind as prose.
  if (typeof value === 'string') value = normalizeCallSyntax(value);
  if (typeof value !== 'string' || !hasLeak(value)) return typeof value === 'string' ? value : '';
  const spans = [];
  for (const pattern of [INVOKE, ALT_ENVELOPE, ALT_NAME_ALL, ALT_ARGUMENT, ALT_ARGUMENTS, RENDERED]) {
    for (const match of value.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  // An `invoke` whose closing tag never arrived, which is the shape a turn cut off at
  // the token limit leaves in history. `parseLeakedCalls` recovers those calls, so the
  // stripping pass has to cover the same span: otherwise the tags go and the argument
  // values stay behind as prose, which is exactly what a later turn imitates.
  for (const open of value.matchAll(INVOKE_OPEN)) {
    const bodyStart = open.index + open[0].length;
    const close = INVOKE_CLOSE.exec(value.slice(bodyStart));
    const end = close === null ? value.length : bodyStart + close.index + close[0].length;
    spans.push([open.index, end]);
  }
  return cutSpans(value, [...spans, ...residualSpans(value)]).trim();
}

/**
 * The whole guard, in the one order that works: cut what never closed, then delete what did.
 *
 * The two halves answer different questions and neither is sufficient alone. `stripLeak`
 * deletes markers whose end it can see, and leaves an unterminated one alone on purpose —
 * in history, a half-block is more likely to be prose *about* the syntax than a call cut off
 * mid-write. `truncateOpenMarkup` does the opposite: it cuts anything still open at the end.
 * A stored turn can be either shape, so replay needs both, in this order — truncating first
 * would take the tail off a complete block and leave its head for `stripLeak` to find.
 *
 * Exported as one function rather than left to each caller to compose, because this is now
 * used on three replay paths and the last time a rule was spelled out in three places, one of
 * them drifted and half a tag reached the screen (F-073).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function scrubForReplay(value) {
  return stripLeak(truncateOpenMarkup(value));
}
