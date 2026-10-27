/**
 * The spellings that defeated recovery, and what each one used to do.
 *
 * Every case here was found by driving the real parser against shapes the modules
 * themselves said they handled. Three of them shared one cause — `hasLeak` returned false,
 * so the driver never held the text and it streamed straight to the screen — which is why a
 * fix in the parser alone would not have helped: the block had to be *recognised* before
 * any parser could be asked about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endsWithMarkerPrefix, hasLeak, hasNativeLeak, parseLeakedCalls, stripLeak } from '../lib/dsml.js';

const B = '\uFF5C';
const open = (s) => `<${B}${B}DSML${B}${B}${s}>`;
const close = (s) => `</${B}${B}DSML${B}${B}${s}>`;

test('the ordinary spelling still works', () => {
  // The control: every fix below is judged against this still passing.
  const text = `${open('calls')}${open('invoke name="pwsh"')}${open('parameter name="command"')}Get-Date${close('parameter')}${close('invoke')}${close('calls')}`;
  const { calls, rest } = parseLeakedCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Date' });
  assert.equal(rest, '');
});

test('whitespace inside the tag does not hide the block', () => {
  // Was: `hasLeak` false, so the driver never held it and it reached the screen as written.
  // Every tag regex here begins `<${SEG}`, and a space after the `<` broke all of them.
  const text = `< ${B}${B} DSML ${B}${B} calls > < ${B}${B} DSML ${B}${B} invoke name="pwsh" > < ${B}${B} DSML ${B}${B} parameter name="command" > Get-Date < ${B}${B} DSML ${B}${B} /parameter >`;
  assert.equal(hasLeak(text), true, 'the block has to be recognised before it can be parsed');
  assert.equal(hasNativeLeak(text), true);
  const { calls } = parseLeakedCalls(text);
  assert.equal(calls.length, 1, 'and then recovered');
  assert.equal(calls[0].name, 'pwsh');
});

test('bars split by spaces still count as a delimiter', () => {
  const text = `<${B} ${B}DSML${B} ${B}calls>`;
  assert.equal(hasLeak(text), true);
});

test("Anthropic's antml spelling is recognised", () => {
  // Not hypothetical: the injected system prompt tells the model to open its thinking with
  // `antmlThinking`, which primes this whole family. Nothing here matched it, so such a
  // block was not held and streamed out untouched.
  const text = '<antml:invoke name="pwsh"><antml:parameter name="command">Get-Date</antml:parameter></antml:invoke>';
  assert.equal(hasLeak(text), true, 'antml has to be seen');
  assert.equal(hasNativeLeak(text), true);
  const { calls } = parseLeakedCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Date' });
});

test('a reply that copied the template calls nothing', () => {
  // The preamble spells the shape out with `TOOL_NAME` and `PARAMETER_NAME`. A weak model
  // reproduces it verbatim. Recovery used to emit a call for a tool named `TOOL_NAME`,
  // which the harness then rejected as unknown — a visible failure where the model had not
  // asked to run anything at all.
  const text = `${open('calls')}${open('invoke name="TOOL_NAME"')}${open('parameter name="PARAMETER_NAME" string="true"')}VALUE${close('parameter')}${close('invoke')}${close('calls')}`;
  const { calls, rest } = parseLeakedCalls(text);
  assert.equal(calls.length, 0, 'a placeholder is not a tool');
  assert.equal(rest, '', 'and its markup is not prose either');
});

test('an abandoned opener leaves no markup on screen', () => {
  // The prose before it survives; the opener does not.
  const text = 'Let me check. <invoke name="pwsh">';
  const { calls, rest } = parseLeakedCalls(text);
  assert.equal(calls.length, 0, 'no parameters, so nothing was actually asked for');
  assert.equal(rest, 'Let me check.');
  assert.equal(/invoke|</u.test(rest), false);
});

test('prose about the syntax keeps its words', () => {
  // The one case where showing the text is right: the user asked what the tags are.
  const text = 'It accepts <parameter name="x"> as an argument.';
  assert.equal(hasLeak(text), true);
  assert.equal(parseLeakedCalls(text).calls.length, 0);
});

test('replayed history loses the markup', () => {
  // `stripLeak` is what keeps a stored leak from teaching the next turn to imitate it.
  for (const text of [
    `< ${B}${B} DSML ${B}${B} calls > < ${B}${B} DSML ${B}${B} invoke name="pwsh" >`,
    '<antml:invoke name="pwsh"><antml:parameter name="command">ls</antml:parameter>',
    '<invoke name="pwsh"><parameter name="command">ls</parameter></invoke>'
  ]) {
    const cleaned = stripLeak(text);
    assert.equal(/invoke|parameter|DSML|antml|｜/u.test(cleaned), false, `still markup: ${JSON.stringify(cleaned)}`);
  }
});

test('ordinary prose is never held or rewritten', () => {
  for (const text of [
    'The build passed in 42 seconds.',
    'Wrap it in <code>backticks</code> and run it.',
    'A table row reads | value > x here.',
    'Use `<invoke>` to start a call, and close it with `</invoke>`.'
  ]) {
    assert.equal(hasLeak(text), false, `false positive on ${JSON.stringify(text)}`);
    assert.equal(parseLeakedCalls(text).calls.length, 0);
  }
});

test('a spaced tag is held while it streams', () => {
  // Held character by character: the hold has to survive `<`, then ` `, then the bars,
  // or the block is printed before it can be recognised.
  let acc = '';
  for (const ch of `< ${B}${B}DSML${B}${B}calls>`) {
    acc += ch;
    // Once the tag is complete `hasNativeLeak` takes over; before that the hold must not let go.
    if (!hasNativeLeak(acc)) assert.equal(endsWithMarkerPrefix(acc), true, `released at ${JSON.stringify(acc)}`);
  }
});

test('an antml tag is held while it streams', () => {
  let acc = '';
  for (const ch of '<antml:invoke name="pwsh">') {
    acc += ch;
    if (!hasNativeLeak(acc)) assert.equal(endsWithMarkerPrefix(acc), true, `released at ${JSON.stringify(acc)}`);
  }
});
