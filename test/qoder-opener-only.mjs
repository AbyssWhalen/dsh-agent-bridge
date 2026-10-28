/**
 * Arguments written with openers and no closing tags.
 *
 * The user's report: a reply that was a shell command followed by three parameter values on
 * their own lines, with no markup visible and no tool call run — the shell text arrived as
 * prose while nothing executed.
 *
 * Reading the live session (`session-87c61dd3`, turn 27 step 2) showed why: the model wrote
 *
 *     <｜｜DSML｜｜ invoke name="pwsh">
 *     <｜｜DSML｜｜ parameter name="command" string="true">Get-ChildItem $t …
 *     <｜｜DSML｜｜ parameter name="description" string="true">List files in active task dir
 *     <｜｜DSML｜｜ parameter name="timeoutMs" string="false">30000
 *     <｜｜DSML｜｜ parameter name="workdir" string="true">D:\DshWork\CyberWork
 *
 * and never closed anything. Two separate failures followed:
 *
 *   1. `SEPARATOR_CLOSED_PARAMETER` stopped a value only at a separator, a close tag or the end
 *      of the string — not at the next opener — so `command` swallowed the other three
 *      parameters as literal markup.
 *   2. With no `invoke` name present at all, nothing could be recovered, so the parameters were
 *      stripped as markup while their values survived as prose and were displayed.
 *
 * Both are covered here, including the boundary that makes the second fix safe: genuine prose
 * that mentions parameters must still be shown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLeakedCalls } from '../lib/dsml.js';

const B = '\uFF5C';
const TAG = /<\/?[ \t]*[\uFF5C|]/u;

const COMMAND = '$t="D:\\DshWork\\CyberWork\\10_active\\T20261028-04-iis6-cred-hunt"; Get-ChildItem $t -Recurse -File | ForEach-Object { "{0,-9} {1}" -f $_.Length, $_.FullName }';
const DESCRIPTION = 'List files in active task dir';
const WORKDIR = 'D:\\DshWork\\CyberWork';

/** The reported shape: openers only, nothing closed. */
const openerOnly = () => [
  `<${B}${B}DSML${B}${B} invoke name="pwsh">`,
  `<${B}${B}DSML${B}${B} parameter name="command" string="true">${COMMAND}`,
  `<${B}${B}DSML${B}${B} parameter name="description" string="true">${DESCRIPTION}`,
  `<${B}${B}DSML${B}${B} parameter name="timeoutMs" string="false">30000`,
  `<${B}${B}DSML${B}${B} parameter name="workdir" string="true">${WORKDIR}`
].join('\n');

test('openers with no closers still yield every parameter separately', () => {
  const result = parseLeakedCalls(openerOnly());
  assert.equal(result.calls.length, 1, 'the call was not recovered');

  const args = JSON.parse(result.calls[0].arguments);
  assert.deepEqual(
    Object.keys(args).sort(),
    ['command', 'description', 'timeoutMs', 'workdir'],
    'a value swallowed the parameters that follow it'
  );
  assert.equal(args.command.trim(), COMMAND, 'command is not exactly the command');
  assert.ok(!TAG.test(args.command), 'command still carries markup');
  assert.equal(args.description.trim(), DESCRIPTION);
  assert.equal(args.timeoutMs, 30000, 'the declared number was not coerced');
  assert.equal(args.workdir.trim(), WORKDIR);
  assert.equal(result.rest, '', 'markup survived as text');
});

test('the same block with closers behaves identically', () => {
  // A guard against the lookahead changing the well-formed path.
  const closed = [
    `<${B}${B}DSML${B}${B} invoke name="pwsh">`,
    `<${B}${B}DSML${B}${B} parameter name="command" string="true">${COMMAND}</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B} parameter name="description" string="true">${DESCRIPTION}</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B} parameter name="workdir" string="true">${WORKDIR}</${B}${B}DSML${B}${B} parameter>`,
    `</${B}${B}DSML${B}${B} invoke>`
  ].join('\n');
  const result = parseLeakedCalls(closed);
  assert.equal(result.calls.length, 1);
  const args = JSON.parse(result.calls[0].arguments);
  assert.deepEqual(Object.keys(args).sort(), ['command', 'description', 'workdir']);
  assert.equal(args.command.trim(), COMMAND);
  assert.equal(result.rest, '');
});

test('arguments with no tool name are not shown as prose', () => {
  // Nothing to run: no `invoke` line anywhere. The values are arguments, not text, so the turn
  // must come out empty rather than displaying a command the user would copy by hand.
  const nameless = [
    `<${B}${B}DSML${B}${B} parameter name="command" string="true">${COMMAND}`,
    `<${B}${B}DSML${B}${B} parameter name="description" string="true">${DESCRIPTION}`,
    `<${B}${B}DSML${B}${B} parameter name="timeoutMs" string="false">30000`,
    `<${B}${B}DSML${B}${B} parameter name="workdir" string="true">${WORKDIR}`
  ].join('\n');

  const result = parseLeakedCalls(nameless);
  assert.equal(result.calls.length, 0, 'a tool was invented from a parameter name');
  assert.equal(result.rest, '', `arguments were shown as text: ${JSON.stringify(result.rest.slice(0, 120))}`);
  assert.ok(!result.rest.includes(WORKDIR), 'the workdir value reached the text channel');
  assert.ok(!result.rest.includes('30000'), 'the timeout value reached the text channel');
});

test('prose about parameters is still shown', () => {
  // The boundary: a sentence that names a parameter is text, and cutting it would break replies
  // that explain their own arguments. Nothing here is a tag.
  const prose = 'I set the parameter name to file_path and left timeoutMs at 30000, which is the default.';
  const result = parseLeakedCalls(prose);
  assert.equal(result.calls.length, 0);
  assert.equal(result.rest, prose, 'ordinary prose was treated as markup');
});

test('a nameless block keeps the prose around it', () => {
  // The values go, the sentence stays. A reply that says what it is about to do and then fails
  // to name the tool should still tell the user what it was thinking.
  const mixed = [
    'I need to list the task directory before editing anything.',
    `<${B}${B}DSML${B}${B} parameter name="command" string="true">${COMMAND}`,
    `<${B}${B}DSML${B}${B} parameter name="description" string="true">${DESCRIPTION}`
  ].join('\n');

  const result = parseLeakedCalls(mixed);
  assert.equal(result.calls.length, 0);
  assert.ok(result.rest.startsWith('I need to list the task directory'), `prose was lost: ${JSON.stringify(result.rest.slice(0, 80))}`);
  assert.ok(!result.rest.includes('Get-ChildItem $t'), 'the command value survived as text');
  assert.ok(!TAG.test(result.rest), 'markup survived as text');
});
