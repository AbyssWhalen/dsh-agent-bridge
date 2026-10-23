/**
 * Offline: what a *compacted* history looks like when it reaches a driver.
 *
 * Compaction rewrites the transcript. That is the one moment the "append or replay" decision is
 * forced, because every message the child was told about is gone. Nothing in the suite covered the
 * shape that produces, and the shape is load-bearing:
 *
 * - The summary is a whole Markdown document with `##` headings and bullets. It is emitted as an
 *   ordinary message and then rendered into the replay envelope, so anything that formats or
 *   trims the transcript acts on a document rather than on chat.
 * - The summary quotes the user verbatim by design ("quote verbatim where the exact wording
 *   matters"). A quoted `User:` line inside it would nest a fake role label one level deeper,
 *   and a model reading the replay cannot tell a quote from the next turn.
 * - `isStraightAppend` must say **no**. Any driver that appended after a compaction would tell
 *   the child "here is one more turn" while the child still holds the pre-compaction history.
 *
 * Run with `node test/compaction-shape.mjs`.
 */
import assert from 'node:assert/strict';
import { flattenConversation, flattenTranscript, isStraightAppend, messageFingerprint, normalizeMessages } from '../lib/messages.js';

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

/** The checkpoint the harness's compaction engine asks for, abbreviated but structurally exact. */
const SUMMARY = [
  '## Primary Request and Intent',
  '- The user wants the build to stop failing on Windows.',
  '- Asked verbatim: "fix the pwsh quoting, it keeps eating my backslashes"',
  '',
  '## Key Technical Concepts',
  '- PowerShell argument quoting, robocopy exit codes',
  '',
  '## Files and Code',
  '- `tools/build.ps1`: the failing entry point',
  '',
  '## Errors and Fixes',
  '- (none)',
  '',
  '## Pending Jobs',
  '- Re-run the build after the fix',
  '',
  '## Current Work',
  '- Editing `tools/build.ps1`',
  '',
  '## Next Step',
  '- Re-run the build'
].join('\n');

/** A post-compaction conversation: summary first, then the new turn. */
function compacted(extra = []) {
  return normalizeMessages([
    { role: 'user', content: [{ type: 'text', text: SUMMARY }] },
    { role: 'user', content: [{ type: 'text', text: 'ok, re-run the build' }] },
    ...extra
  ]);
}

// ── 1. The child must be told everything again ───────────────────────────────────
await check('a compacted history is never a straight append', () => {
  const before = normalizeMessages([
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] }
  ]);
  const after = compacted();
  assert.equal(
    isStraightAppend(before, after),
    false,
    'the driver would append one turn to a child that still holds the pre-compaction history'
  );
});

await check('an ordinary turn after compaction is an append, not a replay', () => {
  // The summary has not changed, so the prefix still matches and only the tail is new. Replaying
  // here would rebuild the whole post-compaction transcript on every turn — the child already
  // holds it, and the rebuild is the expensive half of a compaction.
  const before = compacted();
  const after = normalizeMessages([
    ...before,
    { role: 'assistant', content: [{ type: 'text', text: 'rebuilt.' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] }
  ]);
  assert.equal(isStraightAppend(before.map(messageFingerprint), after), true, 'an appendable turn was replayed');
});

// ── 2. The summary survives the replay envelope intact ──────────────────────────
await check('the summary reaches the child with its headings', () => {
  const rendered = flattenTranscript(compacted());
  for (const heading of ['## Primary Request and Intent', '## Pending Jobs', '## Next Step']) {
    assert.ok(rendered.includes(heading), `the heading ${heading} was lost`);
  }
});

await check('a verbatim user quote does not become a role label', () => {
  const rendered = flattenTranscript(compacted());
  // The quote lives inside a bullet. `User: ` must only ever appear as a line *prefix*, so a
  // line that merely contains the words is fine and a line that starts with it is a fake turn.
  const fakeTurns = rendered
    .split('\n')
    .filter((line) => /^\s*(User|Assistant|Tool|System):/u.test(line))
    .filter((line) => !line.startsWith('User: ') && !line.startsWith('Assistant: '));
  assert.deepEqual(fakeTurns, [], `a quoted role label became its own turn: ${JSON.stringify(fakeTurns)}`);
});

// ── 3. The instruction the user just gave is still the instruction ─────────────
await check('the newest user turn is the instruction, not the summary', () => {
  const rendered = flattenConversation(compacted());
  assert.ok(rendered.endsWith('ok, re-run the build'), `the tail was ${JSON.stringify(rendered.slice(-80))}`);
  assert.ok(rendered.includes('## Primary Request and Intent'), 'the summary was not carried as history');
});

// ── 3b. Two user turns in a row, which is exactly what compaction produces ────
await check('the summary is history and the sentence after it is the instruction', () => {
  // Measured: the harness appends the compaction instruction as a user message and the compacted
  // conversation begins with the summary, also a user message. So the first turn after a
  // compaction has two user messages in a row, and a flattener that puts *both* into the history
  // envelope leaves the actual instruction nowhere.
  const rendered = flattenConversation(compacted());
  const [, body] = rendered.split('[End of conversation so far]');
  assert.equal(
    (body ?? '').trim(),
    'ok, re-run the build',
    `the instruction slot held ${JSON.stringify((body ?? '').trim())}`
  );
});

// ── 4. A tool exchange after compaction keeps its call ─────────────────────────
await check('a replayed tool exchange keeps its call and its result', () => {
  const rendered = flattenTranscript(
    compacted([
      { role: 'assistant', content: [{ type: 'text', text: 'running it' }, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"build.ps1"}' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'build ok' }] }] }
    ])
  );
  assert.ok(rendered.includes('pwsh'), 'the tool name was dropped');
  assert.ok(rendered.includes('build ok'), 'the tool result was dropped');
});

console.log(`\ncompaction shape: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
