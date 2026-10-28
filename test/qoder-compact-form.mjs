/**
 * The compact form: one JSON payload inside one tag pair.
 *
 * Every defect fixed before this one was a boundary problem in the per-parameter dialect, which
 * spends two tags per argument and therefore has no lexical rule for where a value ends:
 *
 *   - F-080a  a bare `</｜｜DSML｜｜>` closer was not recognised, so `command` absorbed the rest
 *   - F-080b  one tag closed one parameter and opened the next
 *   - F-081   the openers arrived with no closers at all, so `command` ran to the end of the block
 *
 * Three spellings, one cause. The compact form puts the arguments in a single JSON object, so the
 * boundaries are quotes and the class of defect cannot arise. It was adopted after measurement,
 * not on theory: seven live cases through the worker runtime — including a value holding braces and
 * quotes, and a value holding the word `parameter` — came back clean, and the only failure seen was
 * a *missing closer around an intact object*, which brace matching recovers.
 *
 * The old dialect stays fully supported: the model still writes it out of habit, and a prompt
 * change does not retroactively fix the conversations that already contain it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLeakedCalls, firstJsonObject } from '../lib/dsml.js';

const B = '\uFF5C';
const O = `<${B}${B}DSML${B}${B}`;
const C = `</${B}${B}DSML${B}${B}`;
const TAG = /<\/?[ \t]*[\uFF5C|]/u;

const ARGS = '{"command":"Get-Date","description":"print the date","timeoutMs":30000}';

/** One compact call. `argumentsCloser` and `invokeCloser` let a caller omit either. */
function compact({ argumentsCloser = true, invokeCloser = true, payload = ARGS, tool = 'pwsh' } = {}) {
  const lines = [`${O} invoke name="${tool}">`, `${O} arguments>${payload}${argumentsCloser ? `${C} arguments>` : ''}`];
  if (invokeCloser) lines.push(`${C} invoke>`);
  return lines.join('\n');
}

test('a properly closed compact call yields every parameter', () => {
  const result = parseLeakedCalls(compact());
  assert.equal(result.calls.length, 1, 'the call was not recovered');
  const args = JSON.parse(result.calls[0].arguments);
  assert.deepEqual(Object.keys(args).sort(), ['command', 'description', 'timeoutMs']);
  assert.equal(args.command, 'Get-Date');
  assert.equal(args.description, 'print the date');
  assert.equal(args.timeoutMs, 30000, 'the JSON number was not kept');
  assert.equal(result.rest, '', 'markup survived as text');
});

test('a missing arguments closer is recovered by brace matching', () => {
  // The live degradation: the object is complete, the tag is not.
  const result = parseLeakedCalls(compact({ argumentsCloser: false }));
  assert.equal(result.calls.length, 1, 'an intact object was thrown away for want of a tag');
  const args = JSON.parse(result.calls[0].arguments);
  assert.equal(args.command, 'Get-Date');
  assert.equal(args.timeoutMs, 30000);
  assert.equal(result.rest, '');
});

test('a missing invoke closer is recovered too', () => {
  const result = parseLeakedCalls(compact({ invokeCloser: false }));
  assert.equal(result.calls.length, 1);
  const args = JSON.parse(result.calls[0].arguments);
  assert.equal(args.description, 'print the date');
  assert.equal(result.rest, '');
});

test('braces and quotes inside a value do not end the payload early', () => {
  // A PowerShell script block. The braces are inside a JSON string, so they are not structure —
  // a brace matcher that ignores string context would cut this in half and lose the call.
  const command = 'Get-ChildItem | ForEach-Object { if ($_.Length -gt 0) { "{0} {1}" -f $_.Name, $_.Length } }';
  const payload = JSON.stringify({ command, description: 'count non-empty files' });
  const result = parseLeakedCalls(compact({ payload }));
  assert.equal(result.calls.length, 1);
  const args = JSON.parse(result.calls[0].arguments);
  assert.equal(args.command, command, 'the script block was truncated at a brace');
  assert.ok(!TAG.test(args.command));
});

test('the word parameter inside a value is just text', () => {
  const command = "Write-Output 'every parameter name is required'";
  const payload = JSON.stringify({ command, description: 'note about parameter names' });
  const result = parseLeakedCalls(compact({ payload }));
  assert.equal(result.calls.length, 1);
  const args = JSON.parse(result.calls[0].arguments);
  assert.equal(args.command, command);
  assert.equal(args.description, 'note about parameter names');
});

test('an escaped quote inside a value does not end the string', () => {
  const command = 'Get-Content $f | ForEach-Object { "[" + $_ + "]" }';
  const payload = JSON.stringify({ command, description: 'bracket every line' });
  const result = parseLeakedCalls(compact({ payload }));
  assert.equal(result.calls.length, 1);
  assert.equal(JSON.parse(result.calls[0].arguments).command, command);
});

test('the older per-parameter dialect still parses', () => {
  // The prompt changed; the conversations already on disk did not. A driver that forgot this would
  // fail on every replayed turn from before the change.
  const text = [
    `${O} invoke name="pwsh">`,
    `${O} parameter name="command" string="true">Get-Date${C} parameter>`,
    `${O} parameter name="description" string="true">print the date${C} parameter>`,
    `${C} invoke>`
  ].join('\n');
  const result = parseLeakedCalls(text);
  assert.equal(result.calls.length, 1);
  const args = JSON.parse(result.calls[0].arguments);
  assert.deepEqual(Object.keys(args).sort(), ['command', 'description']);
  assert.equal(args.command, 'Get-Date');
});

test('a compact payload with no tool name is not shown as prose', () => {
  // Nothing to run: there is no `invoke name=`. The JSON is arguments, not an answer, so the turn
  // must come out empty rather than displaying a call that never happened.
  const text = `${O} arguments>${ARGS}${C} arguments>`;
  const result = parseLeakedCalls(text);
  assert.equal(result.calls.length, 0, 'a tool was invented from a payload');
  assert.equal(result.rest, '', `arguments were shown as text: ${JSON.stringify(result.rest.slice(0, 120))}`);
  assert.ok(!result.rest.includes('Get-Date'), 'the command value reached the text channel');
});

test('prose before a compact block survives', () => {
  const text = `I will check the clock first.\n${compact()}`;
  const result = parseLeakedCalls(text);
  assert.equal(result.calls.length, 1);
  assert.ok(result.rest.startsWith('I will check the clock first'), `prose lost: ${JSON.stringify(result.rest.slice(0, 80))}`);
});

test('brace matching ignores braces inside strings and handles nesting', () => {
  assert.equal(firstJsonObject('x {"a": "}"} y'), '{"a": "}"}');
  assert.equal(firstJsonObject('{"a": {"b": 1}}tail'), '{"a": {"b": 1}}');
  assert.equal(firstJsonObject('no object here'), undefined);
  assert.equal(firstJsonObject('{"unterminated": 1'), undefined);
  // A backslash-escaped quote must not flip the string state.
  assert.equal(firstJsonObject('{"a": "he said \\"hi\\""}'), '{"a": "he said \\"hi\\""}');
});
