/**
 * Closing a conversation while a turn is in flight.
 *
 * The host closes a conversation when a session ends or a turn is abandoned. If the streaming
 * generator is still awaiting its queue at that moment, killing the child is not enough: no
 * further event will arrive, so `next()` waits forever. A caller waiting on that promise is a
 * hung turn with no error and no timeout — the same shape as F-010, one layer up.
 *
 * This is not hypothetical: the probe that found it printed `consumer HUNG after 3006ms` with
 * `chunks=1, failure=none`, meaning the turn had delivered a delta and then simply stopped
 * existing.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-close-'));

/**
 * Start a turn, let one delta arrive, close the conversation, and report how it ended.
 *
 * @returns {Promise<{outcome: string, chunks: number, failure: string|undefined, elapsed: number}>}
 */
async function closeMidTurn() {
  const file = join(scratch, `d-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(['x']));
  process.env.FAKE_DELTAS_FILE = file;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-silent-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  const consume = (async () => {
    try {
      for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1', effort: 'low' })) {
        chunks.push(chunk);
        if (chunk.type === 'error') failure = chunk.error?.message;
      }
    } catch (error) {
      failure = error.message;
    }
  })();

  // Let the delta through, then close mid-turn.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const started = Date.now();
  await conversation.close();

  const outcome = await Promise.race([
    consume.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 3_000))
  ]);
  return { outcome, chunks: chunks.length, failure, elapsed: Date.now() - started };
}

// ── 1. The consumer must be released ───────────────────────────────────────────────
await check('closing mid-turn releases the consumer instead of hanging it', async () => {
  const { outcome, chunks, failure, elapsed } = await closeMidTurn();
  assert.equal(outcome, 'settled', `the consumer was still waiting ${elapsed}ms after close()`);
  // The turn delivered something before it was closed, so what it delivered stands. What
  // matters is that the wait ended and said why.
  assert.notEqual(failure, undefined, `${chunks} chunk(s) delivered and then silence, with no reason given`);
});

await check('the reason says the conversation was closed, not that the model failed', async () => {
  const { failure } = await closeMidTurn();
  assert.match(failure, /clos/iu, `the reason does not say what happened: ${failure}`);
});

await new Promise((resolve) => setTimeout(resolve, 100));
rmSync(scratch, { recursive: true, force: true });

console.log(`\nclose mid-turn: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
