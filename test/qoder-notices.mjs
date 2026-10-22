/**
 * Service notices: what the runtime says instead of an answer.
 *
 * The Qoder runtime replies with a fixed sentence when it cannot serve a turn — the model is
 * busy, the queue is full, the daily Chat allowance is spent. Those sentences arrive over the
 * same channel as model output, so without recognition they become the assistant's answer:
 * the harness records them as content, shows them as if the model wrote them, and replays
 * them as history on the next turn.
 *
 * The table used to be matched whole, and it did not contain the daily-limit sentence. Live
 * capture `capture15` was thirteen turns of exactly that sentence being handed back as
 * answers, with the plugin reporting success each time.
 *
 * Recognising them is also why the match is a prefix rather than the whole string: the runtime
 * appends `Report Issue (input /feedback)` to the limit notice, so an exact comparison misses
 * the real wire text even when the sentence is known.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-notice-'));

/** Verbatim from `capture15/run-01-bad.log`. */
const DAILY_LIMIT = "You've reached your daily usage limit for Chat. Come back tomorrow to continue working with me. Report Issue (input /feedback)";
const BUSY = 'The model is busy and could not complete the request. Please try again later.';

/**
 * Run one turn through the real conversation against a scripted runtime.
 *
 * @param {string[]} deltas
 * @returns {Promise<{text: string, failure: string|undefined}>}
 */
async function turn(deltas) {
  const file = join(scratch, `d-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(deltas));
  process.env.FAKE_DELTAS_FILE = file;
  delete process.env.FAKE_SPLIT;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1', effort: 'low' })) {
      chunks.push(chunk);
      if (chunk.type === 'error') failure = chunk.error?.message;
    }
  } catch (error) {
    failure = error.message;
  } finally {
    await conversation.close();
  }
  return { text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), failure };
}

// ── 1. Notices must not become answers ──────────────────────────────────────────────
await check('a busy notice is reported as a failure, not as an answer', async () => {
  const { text, failure } = await turn([BUSY]);
  assert.equal(text, '', `the notice was handed back as the answer: ${JSON.stringify(text.slice(0, 60))}`);
  assert.notEqual(failure, undefined, 'no failure was reported');
});

await check('the daily-limit notice is reported as a failure, not as an answer', async () => {
  const { text, failure } = await turn([DAILY_LIMIT]);
  assert.equal(text, '', `the notice was handed back as the answer: ${JSON.stringify(text.slice(0, 60))}`);
  assert.notEqual(failure, undefined, 'no failure was reported');
});

await check('the daily-limit notice is recognised however the stream splits it', async () => {
  const { text, failure } = await turn([
    "You've reached your daily usage limit for Chat. ",
    'Come back tomorrow to continue working with me. Report Issue (input /feedback)'
  ]);
  assert.equal(text, '', `the notice was handed back as the answer: ${JSON.stringify(text.slice(0, 60))}`);
  assert.notEqual(failure, undefined, 'no failure was reported');
});

// ── 2. Ordinary prose that mentions the same words is still an answer ───────────────
await check('prose about the limit is not mistaken for the notice', async () => {
  const prose = 'The daily usage limit for Chat is 2900 credits.';
  const { text, failure } = await turn([prose]);
  assert.equal(text, prose, 'a real answer was swallowed');
  assert.equal(failure, undefined, `a real answer was failed: ${failure}`);
});

await check('a sentence that merely starts with You is not a notice', async () => {
  const prose = "You've reached the end of the file. Here is the summary: none.";
  const { text, failure } = await turn([prose]);
  assert.equal(text, prose, 'a real answer was swallowed');
  assert.equal(failure, undefined, `a real answer was failed: ${failure}`);
});

await new Promise((resolve) => setTimeout(resolve, 100));
rmSync(scratch, { recursive: true, force: true });

console.log(`\nqoder notices: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
