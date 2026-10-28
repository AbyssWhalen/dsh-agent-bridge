/**
 * A parameter's closing tag without the word `parameter`.
 *
 * This is the failure that produced both halves of the user's report, from one regex. In the
 * live Qoder session `session-87c61dd3` the model closed parameters with a bare `</｜｜DSML｜｜>`
 * 3,151 times against 92 that spelled the word. The parser required the word, so the lazy
 * value in PARAMETER never stopped where the close was:
 *
 *   * with several parameters, the first swallowed all the rest as literal markup and the shell
 *     rejected the command — the corrupted `{"command": "ssh jp '…'</｜｜DSML｜｜>\n<｜｜DSML｜｜
 *     parameter name=\"description\" …"}` in the session log;
 *   * with a single parameter, nothing was recovered at all and the host threw the turn away as
 *     `EMPTY_RESPONSE` — "the model wrote call syntax as text and none of it could be recovered
 *     (353 characters, reaching for `command`)". That is the "output stopped" the user saw.
 *
 * The fixture is the shape the session actually contained, not an invented one, and the checks
 * are written so that reverting the optional `parameter` in `PARAMETER` turns them red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLeakedCalls, hasLeak } from '../lib/dsml.js';

const B = '\uFF5C';

/** Build a call block whose parameters close with the given spelling. */
const block = (close, params, { closeInvoke = true } = {}) => {
  const lines = [`<${B}${B}DSML${B}${B} invoke name="pwsh">`];
  for (const [name, value] of params) {
    lines.push(`<${B}${B}DSML${B}${B} parameter name="${name}" string="true">${value}${close}`);
  }
  if (closeInvoke) lines.push(`</${B}${B}DSML${B}${B} invoke>`);
  return lines.join('\n');
};

/** The command from the real capture: quotes, brackets, a pipe, and a `$`. */
const COMMAND = "ssh jp 'echo ==APT==; apt-cache policy nmap | head -40; echo $HOME; nproc'";

const MARKUP = /[｜|]{2}|DSML|<\/?(?:invoke|parameter|calls)\b/iu;

/** Every closing spelling the census found in the real session, most common first. */
const CLOSES = {
  'bare': `</${B}${B}DSML${B}${B}>`,
  'bare-one-bar': `</${B}DSML${B}>`,
  'bare-three-bars': `</${B}${B}${B}>`,
  'named': `</${B}${B}DSML${B}${B} parameter>`,
  'named-no-space': `</${B}${B}DSML${B}${B}parameter>`,
  'named-one-bar': `</${B}${B}DSML${B} parameter>`,
  'ascii-bare': '</||DSML||>',
  'ascii-named': '</||DSML|| parameter>'
};

test('every closing spelling keeps the parameters apart', () => {
  for (const [label, close] of Object.entries(CLOSES)) {
    const text = block(close, [
      ['command', COMMAND],
      ['description', 'Check apt packages and egress'],
      ['timeoutMs', '90000']
    ]);
    assert.ok(hasLeak(text), `${label}: the fixture must contain markup`);

    const result = parseLeakedCalls(text);
    assert.equal(result.calls.length, 1, `${label}: expected one call`);
    const args = JSON.parse(result.calls[0].arguments);

    assert.deepEqual(
      Object.keys(args).sort(),
      ['command', 'description', 'timeoutMs'],
      `${label}: the first parameter absorbed the others`
    );
    assert.equal(args.command, COMMAND, `${label}: the command value was altered`);
    assert.equal(args.description, 'Check apt packages and egress', `${label}: description lost`);
    assert.equal(args.timeoutMs, '90000', `${label}: timeout lost`);

    for (const [key, value] of Object.entries(args)) {
      assert.ok(
        !MARKUP.test(String(value)),
        `${label}: "${key}" still carries markup: ${JSON.stringify(String(value).slice(0, 160))}`
      );
    }
  }
});

test('a bare close with a single parameter still yields that parameter', () => {
  // This is the EMPTY_RESPONSE case: one parameter, bare close, no `</invoke>` at all.
  // Before the fix `parametersOf` returned `{}` and the call was dropped entirely.
  const text = block(
    `</${B}${B}DSML${B}${B}>`,
    [['command', COMMAND]],
    { closeInvoke: false }
  );

  const result = parseLeakedCalls(text);
  assert.equal(result.calls.length, 1, 'a fully-specified call was discarded');
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { command: COMMAND });
});

test('a bare close does not swallow the surrounding tags', () => {
  // `</｜｜DSML｜｜ invoke>` and `</｜｜DSML｜｜ calls>` both put a word before the `>`.
  // The optional `parameter` must not treat either as a parameter close.
  for (const wrapper of [`</${B}${B}DSML${B}${B} invoke>`, `</${B}${B}DSML${B}${B} calls>`]) {
    const text = [
      `<${B}${B}DSML${B}${B} calls>`,
      `<${B}${B}DSML${B}${B} invoke name="pwsh">`,
      `<${B}${B}DSML${B}${B} parameter name="command" string="true">${COMMAND}</${B}${B}DSML${B}${B}>`,
      `</${B}${B}DSML${B}${B} invoke>`,
      `</${B}${B}DSML${B}${B} calls>`
    ].join('\n');

    const result = parseLeakedCalls(text);
    assert.equal(result.calls.length, 1, `with ${wrapper}: expected one call`);
    assert.deepEqual(
      JSON.parse(result.calls[0].arguments),
      { command: COMMAND },
      `with ${wrapper}: parameters wrong`
    );
    assert.ok(!MARKUP.test(result.rest), `with ${wrapper}: markup left in the text: ${JSON.stringify(result.rest.slice(0, 120))}`);
  }
});

test('a bare close inside a value does not silently keep the following markup', () => {
  // The value ends at the first bare close. Whatever followed is either another parameter
  // (handled above) or markup that must not reach the screen. Either way the value itself
  // has to come out clean.
  const text = block(`</${B}${B}DSML${B}${B}>`, [
    ['command', 'Get-Date'],
    ['description', 'print the date']
  ]);
  const args = JSON.parse(parseLeakedCalls(text).calls[0].arguments);
  assert.equal(args.command, 'Get-Date');
  assert.ok(!MARKUP.test(args.command));
  assert.ok(!MARKUP.test(args.description));
});

test('the value is not truncated early when it merely mentions a tag', () => {
  // Guarding the other direction: widening the close must not cut a value that quotes this
  // syntax as prose. The docstring case is a tool writing a report about DSML.
  const prose = 'The tag closes with a bar-delimited parameter element.';
  const text = block(`</${B}${B}DSML${B}${B}>`, [['content', prose]]);
  const args = JSON.parse(parseLeakedCalls(text).calls[0].arguments);
  assert.equal(args.content, prose);
});
