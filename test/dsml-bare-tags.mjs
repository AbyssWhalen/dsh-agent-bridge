/**
 * The bare XML spelling of a call: `<invoke name="…">` with no delimiter bars at all.
 *
 * Recovered from a live Qoder session where the tool never ran and the user was shown the
 * markup instead. The stored turn is the shortest possible statement of the bug:
 *
 *     …给你一段可以直接复制到新对话的开场白。 <invoke name="pwsh">
 *     <parameter name="command">$t='D:\DshWork\CyberWork\10_a…
 *
 * — prose, then a bare `invoke`, then a bare `parameter`, and no closing tags because the
 * turn was cut off. Every pass in this module required at least one bar of the native
 * delimiter, so `hasLeak` answered no and the driver never held the block: the markup was
 * rendered as the assistant's answer.
 *
 * Two things about this fixture are load-bearing and easy to lose in a "tidier" version:
 * the leading prose (it must survive), and the missing closers (a truncated turn is the
 * common shape, not an edge case).
 *
 * The regression half of this file matters as much as the recovery half. `normalizeBareTags`
 * rewrites real tags, so a rewrite that is too eager would execute a call the model only
 * quoted — the same trade the native form already makes, and one this module must not make
 * quietly worse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  endsWithMarkerPrefix,
  hasLeak,
  hasNativeLeak,
  parseLeakedCalls,
  stripLeak
} from '../lib/dsml.js';

const B = '\uFF5C';

/** The stored turn, verbatim up to the point the cache truncated it. */
const STORED_TURN =
  '我先确认一下磁盘上的状态文件是否已经写好，然后给你一段可以直接复制到新对话的开场白。 ' +
  '<invoke name="pwsh"> <parameter name="command">$t=\'D:\\DshWork\\CyberWork\\10_a';

/** The same session's earlier turn, where a native wrapper and a bare tag were mixed. */
const MIXED = `好的。<${B}｜DSML｜${B} calls> <invoke name="pwsh"> <parameter name="command">echo hi</parameter>`;

test('the stored turn is recognised as markup at all', () => {
  // The whole failure started here: `hasLeak` said no, so nothing downstream ever ran.
  assert.equal(hasLeak(STORED_TURN), true);
  assert.equal(hasNativeLeak(STORED_TURN), true, 'the driver holds the stream on this');
});

test('the stored turn is recovered as a call', () => {
  const { calls } = parseLeakedCalls(STORED_TURN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.match(JSON.parse(calls[0].arguments).command, /10_a$/);
});

test('the prose before the call survives, the path does not', () => {
  const { rest } = parseLeakedCalls(STORED_TURN);
  assert.match(rest, /开场白/, 'the sentence the model actually said is kept');
  assert.equal(rest.includes('D:\\DshWork'), false, 'the argument value must not be shown as text');
  assert.equal(rest.includes('invoke'), false);
});

test('replayed history is scrubbed of the whole block', () => {
  // This is the self-reinforcing half: leaving the body in history teaches the next turn
  // to write the same thing again.
  const stripped = stripLeak(STORED_TURN);
  assert.match(stripped, /开场白/);
  assert.equal(stripped.includes('D:\\DshWork'), false);
  assert.equal(stripped.includes('invoke'), false);
});

test('a native wrapper with a bare tag inside is one call, not two', () => {
  const { calls, rest } = parseLeakedCalls(MIXED);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'echo hi' });
  assert.equal(rest, '好的。');
});

test('a fully closed bare call is recovered too', () => {
  const closed = [
    '<invoke name="read_file">',
    '<parameter name="path">a.txt</parameter>',
    '</invoke>'
  ].join('\n');
  const { calls, rest } = parseLeakedCalls(closed);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { path: 'a.txt' });
  assert.equal(rest, '');
});

test('a bare calls wrapper is recognised', () => {
  const wrapped = '<calls><invoke name="read_file"><parameter name="path">a.txt</parameter></invoke></calls>';
  const { calls } = parseLeakedCalls(wrapped);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_file');
});

test('the native dialect is untouched', () => {
  const native = [
    `<${B}${B}｜DSML｜${B}${B}calls>`,
    `<${B}${B}｜DSML｜${B}${B}invoke name="pwsh">`,
    `<${B}${B}｜DSML｜${B}${B}parameter name="command">ls</${B}${B}｜DSML｜${B}${B}parameter>`,
    `</${B}${B}｜DSML｜${B}${B}invoke>`,
    `</${B}${B}｜DSML｜${B}${B}calls>`
  ].join('\n');
  const { calls, rest } = parseLeakedCalls(native);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls' });
  assert.equal(rest, '');
});

test('ordinary prose is left alone', () => {
  const prose = 'The build finished successfully in 42 seconds.';
  assert.equal(hasLeak(prose), false);
  assert.equal(parseLeakedCalls(prose).rest, prose);
  assert.equal(stripLeak(prose), prose);
});

test('a bare tag word with no name is not a call', () => {
  // Prose that explains the syntax must survive: only an attribute carrying a name makes
  // a tag look like a call. `<invoke>` on its own is a word in a sentence.
  const prose = 'The docs say you should write <invoke> to start a call.';
  assert.equal(hasLeak(prose), false);
  assert.equal(parseLeakedCalls(prose).rest, prose);
  assert.equal(parseLeakedCalls(prose).calls.length, 0);
});

test('a quoted example is executed — the pre-existing trade, unchanged in kind', () => {
  // Recorded, not celebrated. The native form already behaves this way: a turn that quotes
  // a complete call gets that call run. The bare spelling now behaves identically, which is
  // the point of normalising rather than writing a second parser. What must not regress is
  // that it stays a *complete* call: a fragment in prose still does not execute.
  const quoted = 'Example: <invoke name="pwsh"><parameter name="command">ls</parameter></invoke> — that is how it works.';
  assert.equal(parseLeakedCalls(quoted).calls.length, 1);
  const fragment = 'It accepts <parameter name="x"> as an argument.';
  assert.equal(parseLeakedCalls(fragment).calls.length, 0, 'a lone parameter is never a call');
});

test('a half-typed tag is held, not printed', () => {
  // The stream arrives in deltas. Releasing `<inv` puts half a tag on screen that the
  // later rewrite cannot take back, so the hold has to cover the bare spelling too.
  for (const tail of ['<inv', '<invo', '<invoke', '<invoke ', '</inv', '<paramet', '<call']) {
    assert.equal(endsWithMarkerPrefix(tail), true, `${JSON.stringify(tail)} must be held`);
  }
  assert.equal(endsWithMarkerPrefix('hello'), false);
  assert.equal(endsWithMarkerPrefix('a < b'), false, 'a comparison is not a tag');
});
