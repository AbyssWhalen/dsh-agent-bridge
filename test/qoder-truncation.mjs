/**
 * Truncation, on the driver whose worker says it in a different place.
 *
 * The WorkBuddy side reports the cut in `choices[0].finish_reason`. The Qoder worker reports the
 * same fact in `stream_event.event.delta.stop_reason`, on the `message_delta` frame — the very
 * frame this driver was already reading, because `usage` rides it. It read one field and dropped
 * its sibling:
 *
 *     } else if (event?.type === 'message_delta' && event.usage !== undefined) {
 *       usage = event.usage;
 *     }
 *
 * Verified from the real dumps rather than assumed: every captured `message_delta` carries
 * `delta.stop_reason` (`end_turn` on the healthy turns), so the field is always there and a
 * truncated turn would say `max_tokens` in exactly the same place.
 *
 * The consequence is the one described in `workbuddy-truncation.mjs`: a cut-off turn is reported
 * as a clean finish, and the harness's rule that drops incomplete tool-call blocks on `max-tokens`
 * never runs. That rule is in `dsh-llm`, not in either driver, so both drivers have to say the
 * same word for it to run at all.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';

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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-trunc-'));

/**
 * Run one turn whose worker names a given stop reason.
 *
 * @param {string[]} deltas
 * @param {string} stopReason
 * @returns {Promise<{finish: object|undefined, text: string}>}
 */
async function turn(deltas, stopReason) {
  const file = join(scratch, `t-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(deltas));
  process.env.FAKE_DELTAS_FILE = file;
  process.env.FAKE_STOP_REASON = stopReason;
  delete process.env.FAKE_SPLIT;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} }
  });

  const chunks = [];
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1', effort: 'low' })) {
      chunks.push(chunk);
    }
  } catch {
    // The turn's verdict is not what this check is about.
  } finally {
    await conversation.close();
  }
  return {
    finish: chunks.find((c) => c.type === 'finish')?.reason,
    text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  };
}

// ── 1. The cut must be reported ────────────────────────────────────────────────────
await check('a turn cut off by the token ceiling finishes as max-tokens', async () => {
  const { finish } = await turn(['The first three are 1, 2, 3 and the fo'], 'max_tokens');
  assert.equal(finish?.kind, 'max-tokens', `finished as ${JSON.stringify(finish?.kind)}`);
});

await check('an ordinary turn finishes as stop', async () => {
  const { finish } = await turn(['Done.'], 'end_turn');
  assert.equal(finish?.kind, 'stop', `finished as ${JSON.stringify(finish?.kind)}`);
});

await check('a turn that made a call finishes as tool-calls', async () => {
  const block = [
    '<｜｜DSML｜｜calls>',
    '<｜｜｜｜invoke name="pwsh">',
    '<｜｜｜｜parameter name="command">Get-Location</｜｜｜｜parameter>',
    '</｜｜｜｜invoke>',
    '</｜｜DSML｜calls>'
  ].join('\n');
  const { finish } = await turn([block], 'tool_use');
  assert.equal(finish?.kind, 'tool-calls', `finished as ${JSON.stringify(finish?.kind)}`);
});

// ── 2. Truncation must win over "there were tool calls" ───────────────────────────
await check('a truncated turn that also made a call finishes as max-tokens', async () => {
  const partial = [
    '<｜｜DSML｜｜calls>',
    '<｜｜｜｜invoke name="pwsh">',
    '<｜｜｜｜parameter name="command">Get-Chil'
  ].join('\n');
  const { finish } = await turn([partial], 'max_tokens');
  assert.equal(finish?.kind, 'max-tokens', `finished as ${JSON.stringify(finish?.kind)}`);
});

// ── 3. What did arrive is still delivered ─────────────────────────────────────────
await check('the text that arrived before the cut is still delivered', async () => {
  const { text } = await turn(['The first three are 1, 2, 3'], 'max_tokens');
  assert.equal(text, 'The first three are 1, 2, 3', `text was ${JSON.stringify(text)}`);
});

// ── 4. An unfamiliar reason must not become an unusable finish kind ───────────────
await check('an unrecognised stop reason does not produce a kind the harness rejects', async () => {
  const { finish } = await turn(['Done.'], 'pause_turn');
  assert.ok(
    ['stop', 'tool-calls', 'max-tokens'].includes(finish?.kind),
    `finished as ${JSON.stringify(finish?.kind)}, which the session format does not accept`
  );
});

await new Promise((resolve) => setTimeout(resolve, 100));
delete process.env.FAKE_STOP_REASON;
rmSync(scratch, { recursive: true, force: true });

console.log(`\nqoder truncation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
