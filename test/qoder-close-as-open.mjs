/**
 * A close tag that also opens the next parameter.
 *
 * The live Qoder session contains, inside a recorded `edit` call:
 *
 *   D:\…\20261027-fofa-idle-batch.sh</｜｜DSML｜｜ parameter name="old_string">  echo "…
 *
 * One tag, two jobs: it ends `file_path` and carries `old_string`'s attributes. No closing-tag
 * rule can match it, because it is not a close and not an open. Eight of the 258 tool calls in
 * `session-87c61dd3` have this shape, and the result is the same as the bare-close defect: the
 * value swallows the next parameter as literal markup, so the tool is handed a filename with
 * tags stuck to the end of it and the edit is refused.
 *
 * The fix splits the tag into `</X><X parameter …>` before the other rewrites run. These checks
 * are written so that removing `normalizeCloseAsOpener` from `normalizeCallSyntax` turns them
 * red.
 *
 * One case is deliberately absent: a value whose *text* contains a literal closing tag. No
 * parser can resolve that — the bytes are identical to a real close — and asserting otherwise
 * would encode a requirement that cannot be met.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLeakedCalls, hasLeak } from '../lib/dsml.js';

const B = '\uFF5C';

/** A markup tag inside a value is the signature of a value that ran on. */
const TAG = /<\/?[ \t]*[\uFF5C|]/u;

const FILE_PATH = 'D:\\DshWork\\CyberWork\\10_active\\T20261027-01\\src\\20261027-fofa-idle-batch.sh';
const OLD = '  echo "========"';

/** The shape from the session: the close of parameter 1 doubles as the open of parameter 2. */
const closeAsOpen = (spelling) =>
  [
    `<${B}${B}DSML${B}${B} invoke name="edit">`,
    `<${B}${B}DSML${B}${B} parameter name="file_path" string="true">${FILE_PATH}${spelling} parameter name="old_string">${OLD}</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B} parameter name="new_string" string="true">  echo "new"</${B}${B}DSML${B}${B} parameter>`,
    `</${B}${B}DSML${B}${B} invoke>`
  ].join('\n');

const SPELLINGS = {
  'two bars, DSML': `</${B}${B}DSML${B}${B}`,
  'one bar, DSML': `</${B}DSML${B}`,
  'bare bars': `</${B}${B}`,
  'three bars, DSML': `</${B}${B}${B}DSML${B}${B}`
};

test('a close tag that carries the next parameter does not merge the two', () => {
  for (const [label, spelling] of Object.entries(SPELLINGS)) {
    const text = closeAsOpen(spelling);
    assert.ok(hasLeak(text), `${label}: the fixture must contain markup`);

    const result = parseLeakedCalls(text);
    assert.equal(result.calls.length, 1, `${label}: expected one call`);
    const args = JSON.parse(result.calls[0].arguments);

    assert.deepEqual(
      Object.keys(args).sort(),
      ['file_path', 'new_string', 'old_string'],
      `${label}: parameters merged instead of split`
    );
    assert.equal(args.file_path, FILE_PATH, `${label}: the path kept the following tag`);
    assert.ok(!TAG.test(args.file_path), `${label}: file_path still carries a tag`);
    // `coerce` drops the trailing newline the block had before its close tag; the value's own
    // leading spaces are part of the edit and must survive.
    assert.equal(String(args.old_string), OLD, `${label}: old_string lost`);
    assert.ok(!TAG.test(args.old_string), `${label}: old_string still carries a tag`);
  }
});

test('the split does not damage a normal close tag', () => {
  // A plain `</… parameter>` has no attribute after the word, so the rewrite must leave it be.
  const text = [
    `<${B}${B}DSML${B}${B} invoke name="pwsh">`,
    `<${B}${B}DSML${B}${B} parameter name="command" string="true">Get-Date</${B}${B}DSML${B}${B} parameter>`,
    `<${B}${B}DSML${B}${B} parameter name="description" string="true">print the date</${B}${B}DSML${B}${B} parameter>`,
    `</${B}${B}DSML${B}${B} invoke>`
  ].join('\n');

  const args = JSON.parse(parseLeakedCalls(text).calls[0].arguments);
  assert.deepEqual(Object.keys(args).sort(), ['command', 'description']);
  assert.equal(args.command, 'Get-Date');
  assert.equal(args.description, 'print the date');
});

test('the split leaves ordinary prose alone', () => {
  // A sentence that mentions the word `parameter` but contains no tag must survive unchanged.
  const prose = 'Each parameter is named, and the value follows after the closing angle bracket.';
  const text = [
    `<${B}${B}DSML${B}${B} invoke name="write">`,
    `<${B}${B}DSML${B}${B} parameter name="content" string="true">${prose}</${B}${B}DSML${B}${B}>`,
    `</${B}${B}DSML${B}${B} invoke>`
  ].join('\n');

  const args = JSON.parse(parseLeakedCalls(text).calls[0].arguments);
  assert.equal(args.content, prose, 'prose was rewritten');
  assert.ok(!TAG.test(args.content), 'the prose value now carries a tag');
});

test('splitting a close twice does not invent a parameter', () => {
  // Two parameters in a row, the first written with the doubled tag. The split must yield
  // exactly the two parameters, not a chain.
  const text = [
    `<${B}${B}DSML${B}${B} invoke name="write">`,
    `<${B}${B}DSML${B}${B} parameter name="file_path" string="true">C:\\a.txt</${B}${B}DSML${B}${B} parameter name="content">one</${B}${B}DSML${B}${B} parameter>`,
    `</${B}${B}DSML${B}${B} invoke>`
  ].join('\n');
  const args = JSON.parse(parseLeakedCalls(text).calls[0].arguments);
  assert.deepEqual(Object.keys(args).sort(), ['content', 'file_path']);
  assert.equal(args.file_path, 'C:\\a.txt');
  assert.equal(String(args.content).trim(), 'one');
});
