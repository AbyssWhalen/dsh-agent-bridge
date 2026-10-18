/**
 * Recovering a call that arrived as text.
 *
 * The sample below is a real one, taken from this project's own session log: a
 * model answered a tool-shaped request by writing its native call syntax into the
 * content stream. The markup is quoted with an ASCII bar as well as the fullwidth
 * one, because a model that has seen the ASCII spelling quoted in a conversation
 * reproduces that instead, and both must be recognised.
 *
 * Run with `node test/dsml.mjs`.
 */
import { endsWithMarkerPrefix, hasLeak, parseLeakedCalls, stripLeak } from '../lib/dsml.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function equal(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: ${a} !== ${b}`);
}

/** The marker, spelled the way the tokenizer emits it. */
const M = (name) => `<｜｜DSML｜｜${name}>`;
const CLOSE = (name) => `</｜｜DSML｜｜${name}>`;

/** One leaked block, as a model writes it: indented and newline-separated. */
const LEAKED = [
  M('calls'),
  `  ${M('invoke name="pwsh"')}`,
  `    ${M('parameter name="command" string="true"')}Get-ChildItem D:\\CyberWork${CLOSE('parameter')}`,
  `  ${CLOSE('invoke')}`,
  CLOSE('calls')
].join('\n');

console.log('# detection\n');

check('a leaked block is recognised', () => {
  if (!hasLeak(LEAKED)) throw new Error('not detected');
});

check('ordinary prose is not', () => {
  if (hasLeak('I listed the files for you.')) throw new Error('false positive');
  if (hasLeak('')) throw new Error('empty string');
  if (hasLeak(undefined)) throw new Error('undefined');
});

check('the ASCII spelling is recognised too', () => {
  if (!hasLeak('<||DSML||invoke name="pwsh">x</||DSML||invoke>')) throw new Error('ASCII form missed');
});

console.log('\n# recovery\n');

const parsed = parseLeakedCalls(LEAKED);
check('the call comes back with its name', () => {
  equal(parsed.calls.length, 1, 'count');
  equal(parsed.calls[0].name, 'pwsh', 'name');
});

check('the argument is valid JSON carrying the parameter', () => {
  const args = JSON.parse(parsed.calls[0].arguments);
  equal(args, { command: 'Get-ChildItem D:\\CyberWork' }, 'arguments');
});

check('no markup survives in the leftover text', () => {
  equal(parsed.rest, '', 'rest');
});

check('prose around a leak is kept', () => {
  const mixed = parseLeakedCalls(`Let me check.\n${LEAKED}\nThat should do it.`);
  equal(mixed.calls.length, 1, 'calls');
  equal(mixed.rest.includes('Let me check.'), true, 'leading prose');
  equal(mixed.rest.includes('That should do it.'), true, 'trailing prose');
  equal(hasLeak(mixed.rest), false, 'markup left behind');
});

console.log('\n# parameter types\n');

const typed = [
  M('calls'),
  `  ${M('invoke name="search"')}`,
  `    ${M('parameter name="query" string="true"')}hello${CLOSE('parameter')}`,
  `    ${M('parameter name="limit" number="true"')}5${CLOSE('parameter')}`,
  `    ${M('parameter name="exact" boolean="true"')}true${CLOSE('parameter')}`,
  `  ${CLOSE('invoke')}`,
  CLOSE('calls')
].join('\n');

check('declared types are honoured, not flattened to string', () => {
  const args = JSON.parse(parseLeakedCalls(typed).calls[0].arguments);
  equal(args, { query: 'hello', limit: 5, exact: true }, 'arguments');
});

check('a parameter-less tool is still a call', () => {
  const bare = `${M('calls')}${M('invoke name="npm_test"')}${CLOSE('invoke')}${CLOSE('calls')}`;
  const one = parseLeakedCalls(bare);
  equal(one.calls.length, 1, 'count');
  equal(JSON.parse(one.calls[0].arguments), {}, 'arguments');
});

check('two calls in one block both survive', () => {
  const two = [M('calls'), `  ${M('invoke name="a"')}${CLOSE('invoke')}`, `  ${M('invoke name="b"')}${CLOSE('invoke')}`, CLOSE('calls')].join('\n');
  equal(parseLeakedCalls(two).calls.map((call) => call.name), ['a', 'b'], 'names');
});

console.log('\n# history hygiene\n');

check('stripping keeps the prose and drops the markup', () => {
  const text = `I will look.\n${LEAKED}`;
  const clean = stripLeak(text);
  equal(clean, 'I will look.', 'clean');
  if (hasLeak(clean)) throw new Error('markup survived');
});

check('stripping is a no-op for ordinary text', () => {
  equal(stripLeak('plain answer'), 'plain answer', 'plain');
  equal(stripLeak(undefined), '', 'undefined');
});

console.log('\n# split deltas\n');

check('a marker split across two deltas is anticipated', () => {
  // Each of these is a legal prefix that must be held rather than printed.
  for (const tail of ['<', '<｜', '<｜｜', '<｜｜D', '<｜｜DS', '<｜｜DSM', '<｜｜DSML', '<｜｜DSML｜']) {
    if (!endsWithMarkerPrefix(tail)) throw new Error(`missed prefix ${JSON.stringify(tail)}`);
  }
});

check('finished text is not held back', () => {
  // A trailing `<` is legitimately held — it may be the start of a marker. What
  // must not happen is holding text that has already disproved the marker.
  for (const tail of ['<p>hello', 'a < b', 'done. <not a call>', 'value < 10']) {
    if (endsWithMarkerPrefix(tail)) throw new Error(`held ordinary text ${JSON.stringify(tail)}`);
  }
  if (!endsWithMarkerPrefix('done.<')) throw new Error('a trailing "<" should be held');
});

console.log('');
if (failures > 0) {
  console.log(`# dsml: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# dsml: OK');
