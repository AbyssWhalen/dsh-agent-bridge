/**
 * Offline: `normalizeMessages` must be idempotent, because the host hands back what it was given.
 *
 * Found by tracing why `isStraightAppend` refused an append that was obviously one:
 *
 *     normalizeMessages([{ role: 'user', content: [{ type: 'text', text: 's' }] }])
 *       → [{ role: 'user', text: 's' }]
 *     normalizeMessages([ ...that ])
 *       → [{ role: 'user', text: '' }]        ← the text is gone
 *
 * The normalised shape carries `text`, not `content`, so a second pass read `message.content`,
 * found nothing, and produced an empty message. The fingerprint changes from `user\0 1\0 s` to
 * `user\0 0\0`, which is why the append was refused — but the empty text is the real defect: the
 * harness stores normalised messages, and a conversation restored from disk (or a history the
 * adapter itself produced) goes through this function again on the next turn.
 *
 * What a user would see: a resumed session loses its earlier turns, and the model answers as if
 * the conversation had started empty. That is the kind of loss nobody reports as a bug — it just
 * looks like the model got worse.
 *
 * Run with `node test/normalize-idempotent.mjs`.
 */
import assert from 'node:assert/strict';
import { isStraightAppend, messageFingerprint, normalizeMessages } from '../lib/messages.js';

let passed = 0;
let failed = 0;

async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split('\n')[0]}`);
  }
}

const blocks = (text) => [{ type: 'text', text }];
const source = [
  { role: 'user', content: blocks('first question') },
  { role: 'assistant', content: blocks('first answer') }
];

// ── 1. The property itself ─────────────────────────────────────────────────────
await check('normalising a normalised conversation changes nothing', () => {
  const once = normalizeMessages(source);
  const twice = normalizeMessages(once);
  assert.deepEqual(twice, once, 'the second pass changed the messages');
});

await check('the text survives the second pass', () => {
  const twice = normalizeMessages(normalizeMessages(source));
  assert.equal(twice[0].text, 'first question', `the text became ${JSON.stringify(twice[0].text)}`);
  assert.equal(twice[1].text, 'first answer');
});

await check('the fingerprints are stable', () => {
  const once = normalizeMessages(source);
  const twice = normalizeMessages(once);
  assert.deepEqual(twice.map(messageFingerprint), once.map(messageFingerprint), 'the fingerprints drifted');
});

// ── 2. The consequence that was actually observed ──────────────────────────────
await check('appending to a normalised history is recognised as an append', () => {
  const before = normalizeMessages(source);
  const after = normalizeMessages([
    ...before,
    { role: 'assistant', content: blocks('second answer') },
    { role: 'user', content: blocks('second question') }
  ]);
  assert.equal(after[0].text, 'first question', 'the existing history was blanked while extending it');
  assert.equal(
    isStraightAppend(before.map(messageFingerprint), after),
    true,
    'the driver would replay a transcript where one more turn was all that changed'
  );
});

// ── 3. The shapes that must keep working ──────────────────────────────────────
await check('a tool call and its result survive a second pass', () => {
  const first = normalizeMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"dir"}' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: blocks('a.txt') }] }
  ]);
  const second = normalizeMessages(first);
  assert.equal(second.length, 2, `a message disappeared: ${JSON.stringify(second)}`);
  assert.ok(JSON.stringify(second).includes('pwsh'), `the tool name was lost: ${JSON.stringify(second)}`);
  assert.ok(JSON.stringify(second).includes('a.txt'), `the tool result was lost: ${JSON.stringify(second)}`);
});

await check('an empty assistant turn stays empty rather than becoming text', () => {
  const once = normalizeMessages([{ role: 'assistant', content: [] }]);
  const twice = normalizeMessages(once);
  assert.deepEqual(twice, once);
});

console.log(`\nnormalize idempotence: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
