/**
 * The call dialects Qoder's models fall back to, taken verbatim from live captures.
 *
 * Every string in this file was copied out of a real turn — either the `result` frame or
 * the text a run rendered — and each one cost a turn: the model wrote a complete,
 * recoverable intent as text, nothing recognised it, the markup reached the screen and
 * the tool never ran. Fixing them one at a time from screenshots is what produced four
 * dialects and a fifth still missing, so they are asserted here together.
 *
 * The three families:
 *
 * 1. **DSML with drifting bars.** Canonical is `<｜｜DSML｜｜invoke …>`; the captures show
 *    seven bars before `invoke`, five before `/parameter`, and a word shoved between the
 *    opening bars and `DSML` (`<｜toolDSML｜｜calls>`).
 * 2. **`tool_call` / `tool_name`.** A different syntax the model invents when the first
 *    one appears not to work: `<｜tool_call><name>pwsh</name><arguments>{…}</arguments>
 *    </tool_call>`, and `<｜tool_name>pwsh</｜tool_name>` followed by sibling
 *    `<command>…</command>` tags.
 * 3. **Degeneration.** A runaway run of hundreds of `｜` with no call in it at all. There
 *    is nothing to recover; what must not happen is 500 bars on the screen.
 */
import assert from 'node:assert/strict';
import { hasNativeLeak, parseLeakedCalls, stripLeak, endsWithMarkerPrefix } from '../lib/dsml.js';

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => void} body
 */
function check(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split('\n')[0]}`);
  }
}

/** Assert a captured block yields exactly one call with the given name and arguments. */
function recovers(name, block, expectedName, expectedArguments) {
  check(name, () => {
    assert.equal(hasNativeLeak(block), true, 'the block was not even detected as call syntax');
    const { calls, rest } = parseLeakedCalls(block);
    assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
    assert.equal(calls[0].name, expectedName);
    assert.deepEqual(JSON.parse(calls[0].arguments), expectedArguments);
    assert.ok(rest.length < block.length / 4, `prose left over is too long: ${JSON.stringify(rest.slice(0, 120))}`);
  });
}

// ── 1. DSML with drifting bar counts ──────────────────────────────────────────────────
// Live: seven bars opening `invoke`, five closing `parameter`, no `DSML` on either.
const SEVEN_BARS = [
  '<｜｜DSML｜｜calls>',
  '<｜｜｜｜｜｜｜invoke name="pwsh">',
  '<｜｜｜｜parameter name="command">Get-ChildItem -Force | Select-Object Mode, LastWriteTime, Length, Name</｜｜｜｜｜parameter>',
  '<｜｜｜｜parameter name="description">List files in current directory</｜｜｜｜｜parameter>',
  '</｜｜DSML｜｜calls>'
].join('\n');

recovers('seven bars, no DSML on the children', SEVEN_BARS, 'pwsh', {
  command: 'Get-ChildItem -Force | Select-Object Mode, LastWriteTime, Length, Name',
  description: 'List files in current directory'
});

// Live: the wrapper's opening bars and `DSML` have a word between them.
const INTERPOSED = [
  '<｜toolDSML｜｜calls>',
  '<｜｜DSML｜｜invoke name="pwsh">',
  '<｜DSML｜｜parameter name="command string="true">Get-Location</｜｜DSML｜｜parameter>',
  '<｜DSML｜｜parameter name="description string="true">Print the working directory</｜｜DSML｜｜parameter>',
  '</｜DSML｜｜invoke>',
  '</｜｜DSML｜｜calls>'
].join('\n');

recovers('a word between the opening bars and DSML', INTERPOSED, 'pwsh', {
  command: 'Get-Location',
  description: 'Print the working directory'
});

check('the interposed form is detected as a leak, not as prose', () => {
  assert.equal(hasNativeLeak('<｜toolDSML｜｜calls>'), true);
});

// Live, and the most damaging one: the opening parameter tag lost the word `parameter`
// and kept only one bar, while its closing tag stayed complete. The call was recovered,
// the arguments were not — so the tool ran with `{}` and rejected it with
// `missing required property: command`. The model saw that, concluded its own markup was
// wrong, and rewrote the call four different ways before giving up. Ten of the twenty-two
// calls in one capture had this shape.
const BARE_NAME_OPENERS = [
  '<｜｜DSML｜｜calls>',
  '<｜｜DSML｜invoke name="pwsh">',
  '<｜ name="command">Get-ChildItem -Force | Select-Object Mode, LastWriteTime, Length, Name | Format-Table -AutoSize</｜｜DSML｜｜parameter>',
  '<｜ name="description">List files in current directory</｜｜DSML｜｜parameter>',
  '</｜｜DSML｜invoke>',
  '</｜｜DSML｜calls>'
].join('\n');

recovers('parameter openers reduced to a bare name attribute', BARE_NAME_OPENERS, 'pwsh', {
  command: 'Get-ChildItem -Force | Select-Object Mode, LastWriteTime, Length, Name | Format-Table -AutoSize',
  description: 'List files in current directory'
});

check('the same shape survives with one parameter', () => {
  const one = [
    '<｜｜DSML｜｜calls>',
    '<｜｜DSML｜invoke name="glob">',
    '<｜ name="pattern">*</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜invoke>',
    '</｜｜DSML｜calls>'
  ].join('\n');
  const { calls } = parseLeakedCalls(one);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'glob');
  assert.deepEqual(JSON.parse(calls[0].arguments), { pattern: '*' });
});

// Live: the parameter *name* written as an attribute called `parameter` instead of
// `name`, with a space after the delimiter. `<｜｜DSML｜｜ parameter="command" string="true">`
// — the key is present, just under a different attribute name, so a parser that only
// looks for `name=` reads the block as parameterless.
const PARAMETER_AS_ATTRIBUTE = [
  '<｜｜DSML｜｜calls>',
  '<｜｜｜｜｜invoke name="pwsh">',
  '<｜｜DSML｜｜ parameter="command" string="true">Get-ChildItem -Force -Name</｜｜DSML｜｜parameter>',
  '<｜｜DSML｜｜ parameter="description" string="true">List all file names including hidden</｜｜DSML｜｜parameter>',
  '</｜｜DSML｜｜invoke>',
  '</｜｜DSML｜calls>'
].join('\n');

recovers('parameter name carried in a `parameter=` attribute', PARAMETER_AS_ATTRIBUTE, 'pwsh', {
  command: 'Get-ChildItem -Force -Name',
  description: 'List all file names including hidden'
});

// Live: twenty-three bars opening `invoke`. The bar count was capped at eight, which was a
// guess about how far it drifts; a repetition of the delimiter is not bounded by anything
// the model respects, and what makes a long run safe to accept is the tag name after it,
// not its length.
check('a long bar run before a tag name is still a delimiter', () => {
  const bars = '｜'.repeat(23);
  const block = [
    `<${bars}calls>`,
    `<${bars}invoke name="pwsh">`,
    `<｜｜DSML｜｜parameter name="command">Get-Location</｜｜DSML｜｜parameter>`,
    `</${bars}invoke>`
  ].join('\n');
  assert.equal(hasNativeLeak(block), true);
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location' });
});

check('a runaway bar run with no tag name is not a delimiter', () => {
  assert.equal(hasNativeLeak(`<${'｜'.repeat(200)}......`), false);
});

check('`parameter=` and `name=` are both honoured, and neither invents a key', () => {
  const mixed = [
    '<｜｜DSML｜｜calls>',
    '<｜｜DSML｜｜invoke name="pwsh">',
    '<｜ name="command">Get-Location</｜｜DSML｜｜parameter>',
    '<｜｜DSML｜｜ parameter="description" string="true">print it</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜｜invoke>',
    '</｜｜DSML｜｜calls>'
  ].join('\n');
  const { calls } = parseLeakedCalls(mixed);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location', description: 'print it' });
});

// ── 2. The `tool_call` / `tool_name` family ─────────────────────────────────────────
const TOOL_CALL_JSON = [
  '<｜tool_call>',
  '<name>pwsh</name>',
  '<arguments>{"command": "Get-ChildItem -Force | Select-Object Mode, Name | Format-Table -AutoSize", "description": "List files in current directory"}</arguments>',
  '</tool_call>'
].join('\n');

recovers('tool_call with a JSON arguments child', TOOL_CALL_JSON, 'pwsh', {
  command: 'Get-ChildItem -Force | Select-Object Mode, Name | Format-Table -AutoSize',
  description: 'List files in current directory'
});

// Live: the same idea written with the bare tag names the model quoted from the prompt.
const TOOL_NAME_SIBLINGS = [  'I will list the files in the current directory.',
  '',
  '<｜tool_name>pwsh</｜tool_name>',
  '<command>Get-ChildItem -Force | Format-Table Mode, LastWriteTime, Length, Name</command>',
  '<description>List files in current directory</description>',
  '</tool_response>'
].join('\n');

recovers('tool_name followed by sibling value tags', TOOL_NAME_SIBLINGS, 'pwsh', {
  command: 'Get-ChildItem -Force | Format-Table Mode, LastWriteTime, Length, Name',
  description: 'List files in current directory'
});

check('tool_name keeps the prose that came before it', () => {
  const { calls, rest } = parseLeakedCalls(TOOL_NAME_SIBLINGS);
  assert.equal(calls.length, 1);
  assert.equal(rest, 'I will list the files in the current directory.');
});

// ── 2b. A wrapper around the parameters ───────────────────────────────────────────────
//
// Live, sixth round. The parameters were wrapped in an `<args>` element:
//
//   <｜tool_calls>
//   <tool>
//   <tool_name>pwsh</tool_name>
//   <args>
//   <command>Get-ChildItem -Force | …</command>
//   <description>List files in current directory</description>
//   </args>
//   </tool>
//   </｜tool_calls>
//
// The sibling scan read that as **one** parameter named `args` whose value was the inner
// tags as text. The call then executed with a single unknown argument, the tool rejected it
// for `required property 'command' is missing`, and the model retried in four different
// formats while concluding the harness was broken — the F-012 failure again, one wrapper out.
const WRAPPED_ARGS = [
  '<｜tool_calls>',
  '<tool>',
  '<tool_name>pwsh</tool_name>',
  '<args>',
  '<command>Get-ChildItem -Force | Select-Object Name, Mode, Length | Format-Table -AutoSize</command>',
  '<description>List files in current directory</description>',
  '</args>',
  '</tool>',
  '</｜tool_calls>'
].join('\n');

recovers('a wrapper element around the parameters is unwrapped', WRAPPED_ARGS, 'pwsh', {
  command: 'Get-ChildItem -Force | Select-Object Name, Mode, Length | Format-Table -AutoSize',
  description: 'List files in current directory'
});

check('a wrapper holding a JSON object is unwrapped too', () => {
  const block = [
    '<｜tool_calls>',
    '<tool_name>pwsh</tool_name>',
    '<args>{"command": "Get-Location", "description": "print cwd"}</args>',
    '</｜tool_calls>'
  ].join('\n');
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location', description: 'print cwd' });
});

check('a genuine parameter named args is left alone', () => {
  // The unwrap is only safe when the wrapper is the sole property AND its value looks like a
  // bag. A tool that really takes `args` as a string must keep it.
  const block = [
    '<｜tool_calls>',
    '<tool_name>docker_run</tool_name>',
    '<args>--rm alpine uname -a</args>',
    '</｜tool_calls>'
  ].join('\n');
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.deepEqual(JSON.parse(calls[0].arguments), { args: '--rm alpine uname -a' });
});

check('the canonical dialect unwraps a parameter named args too', () => {
  const block = '<｜｜DSML｜｜calls>\n<｜｜DSML｜invoke name="pwsh">\n'
    + '<｜｜DSML｜parameter name="args"><command>Get-Location</command><description>cwd</description></｜｜DSML｜parameter>\n'
    + '</｜｜DSML｜invoke>\n</｜｜DSML｜calls>';
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location', description: 'cwd' });
});

check('a call wrapped in the <｜tool> container is recognised', () => {
  // The container tag is a marker even though the bare word is not a tag name: without that,
  // a block opening `<｜tool>` released itself as text before anything recognisable arrived.
  const block = [
    '<｜tool>',
    '<tool_name>pwsh</tool_name>',
    '<args><command>Get-Location</command></args>'
  ].join('\n');
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location' });
});

check('the bare word tool in prose is not markup', () => {
  // The reason the container is matched only with a delimiter in front: `tool` is an ordinary
  // word in writing about markup, including this plugin's own documentation.
  for (const prose of ['Use the <tool> element here.', '<tool> is a container', 'A <tool_name> tag']) {
    assert.equal(hasNativeLeak(prose), false, `prose was treated as a marker: ${prose}`);
    assert.equal(stripLeak(prose), prose, `prose was rewritten: ${prose}`);
  }
});

// The `argument` spelling, which the prompt's own example uses.
const TOOL_CALL_ARGUMENT = [
  '<｜tool_call>',
  '<｜name>pwsh</｜name>',
  '<｜argument name="command">Get-Location</｜argument>',
  '<｜argument name="description">Print the working directory</｜argument>',
  '</｜tool_call>'
].join('\n');

recovers('tool_call with argument children that carry a name', TOOL_CALL_ARGUMENT, 'pwsh', {
  command: 'Get-Location',
  description: 'Print the working directory'
});

// ── 3. The tokenizer's own control tokens, rendered to text ──────────────────────────
//
// Live, capture10 run 6. Not a dialect the model invented — these are the model's *native*
// function-calling tokens (`<|begin_of_tool_call|>`, `<|tool_sep|>`, `<|end_of_tool_call|>`)
// arriving in the content stream, with `▁` (U+2581, the glyph a tokenizer uses for a space)
// standing in for the underscores. The bar is the same U+FF5C as everywhere else.
//
//   <｜｜｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh
//   ```json
//   {"command": "Get-ChildItem -Force | Select-Object Name, Mode | Format-Table -AutoSize"}
//   ```<｜｜DSML｜｜call▁end｜>
//
// The arguments are a fenced JSON object, which makes this the *easiest* dialect to
// recover — it is already an argument bag, no `parameter` tags to mis-read. It went
// unrecognised for exactly one reason: nobody had seen it before.
const NATIVE_TOKENS = [
  '<｜｜DSML｜｜calls>',
  '<｜｜｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh',
  '```json',
  '{"command": "Get-ChildItem -Force | Select-Object Name, Mode | Format-Table -AutoSize", "description": "列出当前目录中的文件"}',
  '```<｜｜DSML｜｜call▁end｜>',
  '</｜｜DSML｜calls>'
].join('\n');

recovers('native tool tokens with a fenced json argument bag', NATIVE_TOKENS, 'pwsh', {
  command: 'Get-ChildItem -Force | Select-Object Name, Mode | Format-Table -AutoSize',
  description: '列出当前目录中的文件'
});

check('the native tokens are spelled with underscores and nothing else', () => {
  // The same sequence as a tokenizer would emit it, without the DSML wrapper and with
  // ASCII `_`: a model that is not quoting the plugin's dialect still has to be read.
  const plain = [
    '<|begin_of_tool_call|>function<|tool_sep|>glob',
    '```json',
    '{"pattern": "**/*.md"}',
    '```<|end_of_tool_call|>'
  ].join('\n');
  assert.equal(hasNativeLeak(plain), true, 'the plain token form was not detected');
  const { calls } = parseLeakedCalls(plain);
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.equal(calls[0].name, 'glob');
  assert.deepEqual(JSON.parse(calls[0].arguments), { pattern: '**/*.md' });
});

check('an unparseable argument fence runs nothing but still hides the markup', () => {
  // Half a JSON object: the model was cut off mid-argument. Executing `{}` here would run
  // a tool with no arguments — the F-012 failure again, one dialect over.
  const truncated = [
    '<｜｜｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh',
    '```json',
    '{"command": "Get-Child',
    '</｜｜DSML｜calls>'
  ].join('\n');
  const { calls } = parseLeakedCalls(truncated);
  assert.deepEqual(calls, [], 'a call was invented from an incomplete argument bag');
});

// ── 3b. The displacement dialect: `invoke` slid out of the tag and into the attribute ──
//
// Live, sixth round:
//
//   <｜｜DSML｜｜calls>
//   <｜｜｜｜call invoke="name">pwsh</｜｜DSML｜｜calls>
//   <｜｜｜｜invoke name="command">Get-ChildItem -Force</｜｜DSML｜｜parameter>
//   <｜｜｜｜invoke name="description">List files</｜｜DSML｜｜parameter>
//   </｜｜DSML｜calls>
//
// Read literally this is not a grammar: a `call` element whose `invoke` attribute is
// `name`, and an `invoke` element with a `name` attribute. Read as a displacement it is the
// ordinary form with one token shifted — `invoke name="pwsh"` became
// `call invoke="name">pwsh`, and `parameter name="command"` became `invoke name="command"`.
const DISPLACED = [
  '<｜｜DSML｜｜calls>',
  '<｜｜｜｜call invoke="name">pwsh</｜｜DSML｜｜calls>',
  '<｜｜｜｜invoke name="command">Get-ChildItem -Force | Select-Object Name, Mode, Length | Format-Table -AutoSize</｜｜DSML｜｜parameter>',
  '<｜｜｜｜invoke name="description">List files in current directory</｜｜DSML｜｜parameter>',
  '</｜｜DSML｜calls>'
].join('\n');

recovers('the displacement dialect yields the tool and its parameters', DISPLACED, 'pwsh', {
  command: 'Get-ChildItem -Force | Select-Object Name, Mode, Length | Format-Table -AutoSize',
  description: 'List files in current directory'
});

check('a displacement with no parameters is not turned into a call', () => {
  // The tool name alone never said what to run. Removing the markup is still required;
  // inventing `{}` here is the F-012 mistake one dialect further out.
  const bare = '<｜｜DSML｜｜calls>\n<｜｜｜｜call invoke="name">pwsh</｜｜DSML｜｜calls>\n</｜｜DSML｜calls>';
  assert.deepEqual(parseLeakedCalls(bare).calls, []);
  assert.equal(/[\uFF5C]/u.test(stripLeak(bare)), false);
});

check('the ordinary form is untouched by the displacement branch', () => {
  // Guard check: `invoke name="pwsh"` is the canonical spelling and must keep reading as a
  // tool name, not be re-read as a parameter named `pwsh`.
  const canonical = '<｜｜｜｜｜｜invoke name="pwsh">\n'
    + '<｜｜｜｜parameter name="command">Get-Location</｜｜｜｜｜parameter>\n'
    + '</｜｜｜｜invoke>';
  const { calls } = parseLeakedCalls(canonical);
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location' });
});

// ── 4. Nothing must be invented where there is no call ───────────────────────────────
check('ordinary prose with ASCII pipes is not a call', () => {
  const prose = 'Use `a || b` in JavaScript, and `cmd | tee` in a shell. The table below:\n\n| a | b |\n|---|---|\n';
  assert.equal(hasNativeLeak(prose), false);
  assert.deepEqual(parseLeakedCalls(prose).calls, []);
});

check('a markdown table with fullwidth bars is not a call', () => {
  const table = '<｜ a ｜ b ｜>\n<｜---｜---｜>\n<｜ 1 ｜ 2 ｜>';
  assert.equal(hasNativeLeak(table), false);
});

check('an html tag that merely starts with <b is not a call', () => {
  assert.equal(hasNativeLeak('<b>bold</b> and <i>italic</i>'), false);
});

check('a DSML block with no invoke is not turned into a call', () => {
  const wrapperOnly = '<｜｜DSML｜｜calls>\n</｜｜DSML｜｜calls>';
  assert.deepEqual(parseLeakedCalls(wrapperOnly).calls, []);
  assert.equal(stripLeak(wrapperOnly), '');
});

check('a tool_name with no arguments is a legal parameterless call', () => {
  const bare = '<｜tool_name>pwsh</｜tool_name>';
  assert.equal(hasNativeLeak(bare), true);
  const { calls } = parseLeakedCalls(bare);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), {});
});

// ── 4. History hygiene ──────────────────────────────────────────────────────────────
check('a closing tag repeated to the budget and truncated mid-tag leaves nothing behind', () => {
  // Live: after a complete call, the model repeated `</｜｜DSML｜parameter>` dozens of times
  // and ran out of budget inside the last one. `stripLeak` removes this from replayed
  // history — an assistant turn carrying markup comes back as an example to copy — but the
  // residue rule required a closing `>`, so the truncated tail survived on its own line.
  // Measured across three frame dumps: eight strings kept `</｜｜DSML｜` after stripping.
  const repeated = '<｜｜DSML｜｜calls>\n<｜｜DSML｜invoke name="pwsh">\n'
    + '<｜｜DSML｜parameter name="command">Get-Location</｜｜DSML｜parameter>\n'
    + '</｜｜DSML｜parameter>\n'.repeat(60)
    + '</｜｜DSML｜param';
  const stripped = stripLeak(repeated);
  assert.equal(/[\uFF5C\u2581]/u.test(stripped), false, `bars survived: ${JSON.stringify(stripped.slice(-80))}`);
});

check('a closing tag truncated at the very end of the string leaves nothing behind', () => {
  const tail = '<｜｜DSML｜｜calls>\n<｜｜DSML｜invoke name="pwsh">\n'
    + '<｜｜DSML｜parameter name="command">Get-Location</｜｜DSML｜parameter>\n'
    + '</｜｜DSML｜param';
  assert.equal(/[\uFF5C\u2581]/u.test(stripLeak(tail)), false);
});

check('the closing-tag repetition is still exactly one call', () => {
  // The repetition must not be read as sixty parameterless calls, and the one real call
  // must survive it.
  const block = '<｜｜DSML｜｜calls>\n<｜｜DSML｜invoke name="pwsh">\n'
    + '<｜｜DSML｜parameter name="command">Get-Location</｜｜DSML｜parameter>\n'
    + '</｜｜DSML｜invoke>\n'
    + '</｜｜DSML｜parameter>\n'.repeat(60);
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location' });
});

check('every dialect strips out of replayed history', () => {
  for (const block of [SEVEN_BARS, INTERPOSED, TOOL_CALL_JSON, TOOL_NAME_SIBLINGS, TOOL_CALL_ARGUMENT]) {
    const stripped = stripLeak(block);
    assert.equal(/[\uFF5C]/u.test(stripped), false, `bars survived: ${JSON.stringify(stripped.slice(0, 120))}`);
    assert.equal(/\btool_name\b|\btool_call\b|\barguments\b/u.test(stripped), false, `tags survived: ${JSON.stringify(stripped.slice(0, 120))}`);
  }
});

// ── 5. The tail hold has to know the new tag names ───────────────────────────────────
check('a marker prefix is held for each dialect tag name', () => {
  for (const tail of ['<', '<｜', '<｜｜', '<｜｜DSML', '<｜｜DSML｜｜', '<｜tool', '<｜tool_C', '<｜name', '<｜arg', '<｜parameter']) {
    assert.equal(endsWithMarkerPrefix(tail), true, `tail was released: ${JSON.stringify(tail)}`);
  }
});

check('a finished marker followed by prose is released', () => {
  assert.equal(endsWithMarkerPrefix('<｜｜DSML｜｜hello world'), false);
});

console.log(`\ndsml dialects: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
