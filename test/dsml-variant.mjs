/**
 * The envelope as Qwen-3.8-MAX actually writes it.
 *
 * A real turn on `qoder/qmodel_38max` at extra-high emitted every opening tag with
 * a **single** bar (`<｜｜DSML｜invoke …>`) while closing with the canonical two
 * (`</｜｜DSML｜｜invoke>`). The parser demanded two on both sides, so nothing was
 * recognised: the whole envelope streamed into the chat as text, and the turn then
 * degenerated inside a long shell argument and cut off. This pins the one-character
 * variant so the guard cannot miss it again.
 *
 * Run with `node test/dsml-variant.mjs`.
 */
import { hasLeak, hasNativeLeak, parseLeakedCalls, stripLeak, endsWithMarkerPrefix } from '../lib/dsml.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Open: one bar after DSML. Close: two. Exactly as observed.
const OPEN = (name) => `<｜｜DSML｜${name}>`;
const CLOSE = (name) => `</｜｜DSML｜｜${name}>`;

const TODO =
  `${OPEN('invoke name="todo_write"')}` +
  `${OPEN('parameter name="todos" string="true"')}[{"content":"a"}]${CLOSE('parameter')}` +
  `${CLOSE('invoke')}`;

const PWSH =
  `${OPEN('invoke name="pwsh"')}` +
  `${OPEN('parameter name="command" string="true"')}Set-Location D:\\repo; node _probe\\x.mjs${CLOSE('parameter')}` +
  `${OPEN('parameter name="description" string="true"')}Run the probe${CLOSE('parameter')}` +
  `${CLOSE('invoke')}`;

// The degenerate stretch: the model stopped writing a command and started emitting
// one character per line. It is inside the parameter value, so a working parser
// removes it with the block instead of printing the vertical column.
const DEGENERATE =
  `${OPEN('invoke name="pwsh"')}` +
  `${OPEN('parameter name="command" string="true"')}$logs = Get-ChildItem "` +
  ['e', 'n', 'v', ':', 'U', 'S', 'E', 'R', 'P', 'R', 'O', 'F', 'I', 'L', 'E'].join('\n') +
  `${CLOSE('parameter')}` +
  `${OPEN('parameter name="description" string="true"')}Read logs${CLOSE('parameter')}` +
  `${CLOSE('invoke')}`;

const LEAK = `I will check.\n<｜｜DSML｜calls>\n${TODO}\n${PWSH}\n${DEGENERATE}\n</｜｜DSML｜｜calls>\nDone.`;

console.log('# a single-bar opening is still the envelope\n');

check('the one-bar form is detected', () => {
  assert(hasNativeLeak(OPEN('invoke name="x"')), 'opening tag not detected');
  assert(hasLeak(OPEN('parameter name="x"')), 'parameter not detected');
});

check('every call in the leaked turn is recovered', () => {
  const parsed = parseLeakedCalls(LEAK);
  equal(parsed.calls.length, 3, 'call count');
  equal(parsed.calls[0].name, 'todo_write', 'first name');
  equal(parsed.calls[1].name, 'pwsh', 'second name');
  equal(parsed.calls[2].name, 'pwsh', 'third name');
  equal(JSON.parse(parsed.calls[0].arguments).todos, '[{"content":"a"}]', 'string parameter');
  assert(JSON.parse(parsed.calls[1].arguments).command.includes('node _probe'), 'command lost');
});

check('no markup survives in the remaining text', () => {
  const parsed = parseLeakedCalls(LEAK);
  assert(!/DSML/u.test(parsed.rest), `markup left: ${JSON.stringify(parsed.rest)}`);
  assert(!/invoke name=/u.test(parsed.rest), `opening tag left: ${JSON.stringify(parsed.rest)}`);
  assert(!/parameter name=/u.test(parsed.rest), `parameter left: ${JSON.stringify(parsed.rest)}`);
});

check('the prose around the envelope is kept', () => {
  const parsed = parseLeakedCalls(LEAK);
  assert(parsed.rest.includes('I will check.'), `leading prose lost: ${JSON.stringify(parsed.rest)}`);
  assert(parsed.rest.includes('Done.'), `trailing prose lost: ${JSON.stringify(parsed.rest)}`);
});

check('stripLeak removes the one-bar form from history', () => {
  const cleaned = stripLeak(LEAK);
  assert(!/DSML/u.test(cleaned), `markup left: ${JSON.stringify(cleaned)}`);
  assert(cleaned.includes('I will check.'), 'prose dropped');
});

console.log('\n# a parameter tag missing its quote still yields a usable call\n');

// Observed verbatim: the model drops the quote after the name, so the name group
// reads `command string=` and the type attribute is glued to it.
const MALFORMED =
  `${OPEN('invoke name="pwsh"')}` +
  `${OPEN('parameter name="command string="true"')}echo QWEN38_OK${CLOSE('parameter')}` +
  `${CLOSE('invoke')}`;

check('the glued name and attribute are split apart', () => {
  const parsed = parseLeakedCalls(MALFORMED);
  equal(parsed.calls.length, 1, 'call count');
  const args = JSON.parse(parsed.calls[0].arguments);
  equal(args.command, 'echo QWEN38_OK', 'command');
  assert(!('command string=' in args), `bad key survived: ${JSON.stringify(args)}`);
});

check('the declared string type is still honoured', () => {
  const parsed = parseLeakedCalls(MALFORMED);
  equal(typeof JSON.parse(parsed.calls[0].arguments).command, 'string', 'type');
});

console.log('\n# a delta split inside a one-bar marker is held\n');

check('every prefix of the one-bar opening is held', () => {
  for (const tail of ['<', '<｜', '<｜｜', '<｜｜D', '<｜｜DS', '<｜｜DSM', '<｜｜DSML', '<｜｜DSML｜', '<｜｜DSML｜i']) {
    assert(endsWithMarkerPrefix(`text ${tail}`), `not held: ${JSON.stringify(tail)}`);
  }
});

check('the canonical two-bar prefix is still held', () => {
  assert(endsWithMarkerPrefix('text <｜｜DSML｜｜'), 'two-bar prefix not held');
  assert(endsWithMarkerPrefix('text <||DSML|'), 'mixed ASCII prefix not held');
});

check('ordinary angle brackets release immediately', () => {
  assert(!endsWithMarkerPrefix('compare a < b'), 'prose held');
  assert(!endsWithMarkerPrefix('List<T>'), 'generic held');
});

console.log('\n# the letters are dropped entirely\n');

/*
 * The other degradation, and the worse of the two: a live turn inside a real DSH
 * agent loop wrote the opening delimiter as five fullwidth bars with **no** `DSML`
 * at all — `<｜｜｜｜｜invoke name="pwsh">` — while still writing canonical `parameter`
 * tags and a canonical closing tag in the same envelope.
 *
 * The parser required the literal letters, so the envelope was not recognised. Two
 * things followed: the markup rendered in the transcript as a wall of bars, and
 * because it was never parsed as a call, **the tool never ran**. The turn was spent
 * and the user got nothing. Requiring the letters is the mistake; the bars alone are
 * unambiguous when a tag name follows them.
 */
const BARE_OPEN = (name) => `<｜｜｜｜｜${name}>`;
const BARE_ENVELOPE =
  '<｜｜DSML｜｜calls>' +
  `${BARE_OPEN('invoke name="pwsh"')}` +
  `${OPEN('parameter name="command" string="true"')}Get-ChildItem -File${CLOSE('parameter')}` +
  `${OPEN('parameter name="description" string="true"')}List .txt files${CLOSE('parameter')}` +
  `${CLOSE('invoke')}List .txt files via PowerShell`;

check('the letterless delimiter is recognised as call syntax', () => {
  assert(hasNativeLeak(BARE_OPEN('invoke name="pwsh"')), 'not detected');
  assert(hasLeak(BARE_ENVELOPE), 'not detected inside the envelope');
});

check('the call written with it is recovered', () => {
  const parsed = parseLeakedCalls(BARE_ENVELOPE);
  equal(parsed.calls.length, 1, 'call count');
  equal(parsed.calls[0].name, 'pwsh', 'tool name');
  const args = JSON.parse(parsed.calls[0].arguments);
  equal(args.command, 'Get-ChildItem -File', 'command');
  equal(args.description, 'List .txt files', 'description');
});

check('the prose beside it is kept, and the bars are not', () => {
  equal(parseLeakedCalls(BARE_ENVELOPE).rest, 'List .txt files via PowerShell', 'rest');
  equal(stripLeak(BARE_ENVELOPE), 'List .txt files via PowerShell', 'stripped');
});

check('a letterless delimiter split across deltas is held', () => {
  for (const tail of ['<｜', '<｜｜', '<｜｜｜', '<｜｜｜｜', '<｜｜｜｜｜', '<｜｜｜｜｜inv', '<｜｜｜｜｜invo']) {
    assert(endsWithMarkerPrefix(`text ${tail}`), `not held: ${JSON.stringify(tail)}`);
  }
});

/*
 * The guard that makes the letterless form safe to accept. A run of bars on its own
 * is ordinary in shell pipelines, C operators and diagrams; treating every `<||` as
 * the start of a call would hold text that never had a call in it, and `stripLeak`
 * would then delete the bars from replayed history.
 */
check('a run of bars in prose is not a call', () => {
  for (const prose of ['a <|| b', 'x <| y', 'pipe <||> operator', 'if (a < |b|) {}', 'a <||||||| b']) {
    assert(!hasNativeLeak(prose), `treated as a call: ${JSON.stringify(prose)}`);
    equal(stripLeak(prose), prose, `mangled: ${JSON.stringify(prose)}`);
  }
});

check('a tag name after the bars is what makes it a call', () => {
  assert(hasNativeLeak('<｜｜｜｜｜invoke name="x">'), 'letterless invoke not detected');
  assert(hasNativeLeak('<||||||parameter name="x">'), 'letterless parameter not detected');
  assert(!hasNativeLeak('<||||||invoked'), 'a longer word is not the tag');
});

console.log('');
if (failures > 0) {
  console.log(`# dsml-variant: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# dsml-variant: OK');
