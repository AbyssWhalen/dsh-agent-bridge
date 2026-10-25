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
