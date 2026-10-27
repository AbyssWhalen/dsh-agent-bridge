/**
 * The envelope that names no tool.
 *
 * Reported from a live Qoder session, twice in one conversation: the model wrote the
 * outer `calls` wrapper and a `parameter`, and never wrote the `invoke` that carries the
 * tool name. Everything the wrapper held — a PowerShell here-string, in the report —
 * was rendered into the chat as prose, tags stripped and body intact.
 *
 * Why the existing rules did not catch it: `INVOKE` needs `<…invoke name="…">`, so a
 * block without one never became a span; the residue passes then removed the tags that
 * *were* recognised and left the body, which is the worst of both — the markup is gone,
 * so it no longer looks like a bug, and the payload is on screen.
 *
 * The fixture below is the reported shape, not a tidied version of it:
 *
 *   - the wrapper is `<｜｜DSML｜｜ calls>`, with a **space** before the tag name,
 *   - it closes with `</｜｜ calls>` — a **different bar count**,
 *   - a second parameter opens with a **halfwidth** bar, `<｜｜DSML｜| parameter …>`,
 *   - and one closer is a bare `</｜｜DSML｜｜>` with no tag name at all.
 *
 * Every one of those degradations is load-bearing: a stricter pattern on any of them
 * leaves the block in the text. That is why the assertions here are about the *body* —
 * the here-string text — and not just about the tags.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasLeak, parseLeakedCalls, stripLeak } from '../lib/dsml.js';

const B = '\uFF5C';
const QUOTE_AT = String.fromCharCode(39) + '@';

/** The reported turn, reconstructed line for line. */
const REPORTED = [
  `<${B}｜DSML｜${B} calls> <${B}｜DSML｜${B} parameter name="command">$t = ${QUOTE_AT}`,
  'id: T20261025-01 title: SSH 跳板机渗透环境搭建 slug: ssh-jump-pentest status: active',
  'priority: medium tags: [pentest,infra,skill] created: 20261025 updated: 20261025',
  'owner: YG scope: 本地 Windows DSH + SSH 跳板机（Linux，待提供）',
  'targets: [] deliverables: [RESULT.md, ~/.agents/skills/api-recon]',
  '',
  'SSH 跳板机渗透环境搭建',
  `${QUOTE_AT} Set-Content -LiteralPath 'D:\\x\\TASK.md' -Value $t -Encoding UTF8 'written' </${B}｜DSML｜${B}> <${B}| parameter name="description">Write TASK.md</${B}${B}> </${B}${B}> </${B}${B} calls>`
].join('\n');

test('the reported envelope is still recognised as markup', () => {
  assert.equal(hasLeak(REPORTED), true);
});

test('none of the reported body survives as prose', () => {
  const { rest } = parseLeakedCalls(REPORTED);
  // The here-string is the thing the user saw. Not one line of it may come back.
  assert.equal(rest.includes('Set-Content'), false, 'the here-string body must not survive');
  assert.equal(rest.includes('跳板机'), false, 'the front-matter body must not survive');
  assert.equal(rest.trim(), '', `nothing should be left; got: ${JSON.stringify(rest.slice(0, 120))}`);
});

test('the replay path is clean too, not just the recovery path', () => {
  // These are two different callers. `stripLeak` is what history rewriting uses; a fix
  // that only touched `parseLeakedCalls` would leave the leak seeding the next turn.
  const stripped = stripLeak(REPORTED);
  assert.equal(stripped.trim(), '', `stripLeak must leave nothing; got: ${JSON.stringify(stripped.slice(0, 120))}`);
});

test('a nameless envelope is not turned into a call', () => {
  // No tool name appears anywhere in that fragment — only parameter keys. Inventing one
  // would run a tool the model never asked for, so the block is dropped, not recovered.
  const { calls } = parseLeakedCalls(REPORTED);
  assert.equal(calls.length, 0, 'no call may be invented from a fragment that names no tool');
});

test('an envelope that does name a tool keeps being recovered', () => {
  // The guard has to be "contains an invoke", not "is a calls wrapper": a well-formed
  // envelope must still yield its call rather than being deleted as nameless.
  const good = [
    `<${B}｜DSML｜${B} calls>`,
    `<${B}｜DSML｜${B} invoke name="pwsh">`,
    `<${B}｜DSML｜${B} parameter name="command">ls</${B}｜DSML｜${B} parameter>`,
    `</${B}｜DSML｜${B} invoke>`,
    `</${B}｜DSML｜${B} calls>`
  ].join('\n');
  const { calls, rest } = parseLeakedCalls(good);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' });
  assert.equal(rest.trim(), '');
});

test('prose around a nameless envelope is kept', () => {
  // The block is deleted; the sentence that introduced it is the model's actual answer.
  const mixed = `准备写入任务卡：\n${REPORTED}\n以上。`;
  const { rest } = parseLeakedCalls(mixed);
  assert.equal(rest.includes('准备写入任务卡'), true, 'leading prose survives');
  assert.equal(rest.includes('以上'), true, 'trailing prose survives');
  assert.equal(rest.includes('Set-Content'), false, 'the body does not');
});

test('an unterminated nameless envelope does not eat the turn', () => {
  // A stream cut off mid-call: the wrapper opens and never closes. Deleting from the
  // opener to the end of the string would throw away text in a still-building turn, so
  // this case must keep what follows.
  const cut = `<${B}｜DSML｜${B} calls> <${B}｜DSML｜${B} parameter name="command">ls`;
  const { rest } = parseLeakedCalls(cut);
  assert.equal(rest.includes('ls') || rest.trim() === '', true, 'must not throw');
  // And whatever it does with the fragment, it must not claim a call.
  assert.equal(parseLeakedCalls(cut).calls.length, 0);
});

/**
 * The second report, from the same vendor.
 *
 * This one ends with `</invoke>` and never has an `<invoke name="…">` opener — and the
 * first version of this rule tested for the *word* `invoke`, so that trailing closer
 * satisfied the guard and the block was skipped whole. The lesson is in the fixture: a
 * closing tag is not evidence that a call was ever named.
 *
 * It also spells the closer with the full lettered delimiter, `</｜｜DSML｜｜ calls>`, where
 * the first report used a bare `</｜｜ calls>`. A close pattern that accepted only one of
 * the two would have looked fixed against whichever sample it was written from.
 */
const WITH_TRAILING_CLOSER = [
  `<${B}｜DSML｜${B} calls> <${B}｜DSML｜${B} parameter name="command" string="true">`,
  "$w=' D:\\DshWork\\CyberWork ';",
  "$TRACKED30ASSETS=' +((git -C $w ls-files '30_assets' | Measure-Object).Count);",
  "'GIT_STATUS_ROOT:'; git -C $w status --porcelain --untracked-files=normal 2>&1",
  `</${B}｜DSML｜${B} parameter>`,
  `<${B}｜DSML｜${B} parameter name="description" string="true">Check git tracking</${B}｜DSML｜${B} parameter>`,
  `</${B}｜DSML｜${B} invoke> </${B}｜DSML｜${B} calls>`
].join('\n');

test('a trailing </invoke> does not make an unnamed block recoverable', () => {
  const { calls, rest } = parseLeakedCalls(WITH_TRAILING_CLOSER);
  assert.equal(calls.length, 0, 'no opener named a tool, so no call may be invented');
  assert.equal(rest.trim(), '', `the body must not survive; got ${JSON.stringify(rest.slice(0, 120))}`);
});

test('the replay path drops it too', () => {
  assert.equal(stripLeak(WITH_TRAILING_CLOSER).trim(), '');
});

test('both closer spellings are recognised', () => {
  // Bare closer (first report) and lettered closer (second report) must both terminate
  // the block. A pattern written against one sample silently ignores the other.
  for (const closer of [`</${B}${B} calls>`, `</${B}｜DSML｜${B} calls>`]) {
    const block = [
      `<${B}｜DSML｜${B} calls>`,
      `<${B}｜DSML｜${B} parameter name="command">payload</${B}｜DSML｜${B} parameter>`,
      closer
    ].join('\n');
    assert.equal(
      parseLeakedCalls(block).rest.trim(),
      '',
      `closer ${JSON.stringify(closer)} must terminate the block`
    );
  }
});

test('a string="true" attribute neither blocks recovery nor leaks into the arguments', () => {
  // The second report spells both parameters `name="…" string="true"`. That is an
  // attribute the tool schema never declares, so it must not arrive as an argument.
  const good = [
    `<${B}｜DSML｜${B} calls>`,
    `<${B}｜DSML｜${B} invoke name="pwsh">`,
    `<${B}｜DSML｜${B} parameter name="command" string="true">ls</${B}｜DSML｜${B} parameter>`,
    `<${B}｜DSML｜${B} parameter name="description" string="true">List</${B}｜DSML｜${B} parameter>`,
    `</${B}｜DSML｜${B} invoke>`,
    `</${B}｜DSML｜${B} calls>`
  ].join('\n');
  const { calls, rest } = parseLeakedCalls(good);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls', description: 'List' });
  assert.equal(rest.trim(), '');
});

test('a named invoke still wins over the nameless rule when both are present', () => {
  // Two envelopes in one turn, the second one degenerate. The first must still be
  // recovered — this is also the case a stateful `g` regex would answer wrongly,
  // because `lastIndex` from the first match would decide the second.
  const two = [
    `<${B}｜DSML｜${B} calls><${B}｜DSML｜${B} invoke name="read_file"><${B}｜DSML｜${B} parameter name="path">a.txt</${B}｜DSML｜${B} parameter></${B}｜DSML｜${B} invoke></${B}｜DSML｜${B} calls>`,
    '中间',
    `<${B}｜DSML｜${B} calls><${B}｜DSML｜${B} parameter name="command">junk</${B}｜DSML｜${B} parameter></${B}｜DSML｜${B} invoke></${B}｜DSML｜${B} calls>`
  ].join('\n');
  const { calls, rest } = parseLeakedCalls(two);
  assert.equal(calls.length, 1, 'exactly the named envelope yields a call');
  assert.equal(calls[0].name, 'read_file');
  assert.equal(rest.includes('junk'), false, 'the unnamed envelope is still dropped');
  assert.equal(rest.includes('中间'), true, 'prose between them survives');
});
