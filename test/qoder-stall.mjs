/**
 * A Qoder turn that goes silent must not wait forever.
 *
 * The WorkBuddy driver has a stall guard; this one has none. A worker that streams one delta and
 * then neither finishes nor dies leaves the turn in `await queue.next()` with nothing to wake it:
 * no error frame, no `result`, no timeout. The turn does not fail — it simply never ends, and the
 * only escapes are the user cancelling or the whole session being closed.
 *
 * Measured on the existing fixture (`fake-silent-runtime.mjs`, which sends one delta and no
 * `result`): the consumer hangs. That is a worse outcome than a misclassified failure, because
 * a failure at least reaches the retry policy and the session log.
 *
 * The guard is the same shape as the other driver's on purpose — an idle *deadline*, not an
 * interval, so a long turn that keeps producing events is never killed by the clock. Both
 * drivers had to learn this separately last round; this time it is written down as a parity
 * guarantee so it cannot be one-sided again.
 *
 * The failure kind is `timeout`, which maps to the harness's retryable `TIMEOUT`, because the
 * cause is a transport-level silence rather than anything the user can fix.
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

const silentRuntime = fileURLToPath(new URL('./fake-silent-runtime.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'dsh-qstall-'));

/**
 * Run one turn against the silent worker, with a bounded wait.
 *
 * The wait itself is what is being tested, so it needs its own bound: without one, a hang here
 * would hang the suite rather than report a defect. `HUNG` is a distinct verdict from `FAILED` —
 * one means "still waiting", the other means "stopped, wrong reason".
 *
 * @param {number} idleTimeoutMs
 * @returns {Promise<{verdict: 'TIMED_OUT'|'HUNG'|'FAILED'|'FINISHED', failure?: object, text: string}>}
 */
async function turn(idleTimeoutMs) {
  const conversation = new QoderConversation({
    runtimePath: silentRuntime,
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} },
    idleTimeoutMs
  });

  const chunks = [];
  let failure;
  let hung = false;
  const HUNG = Symbol('hung');
  const guard = new Promise((resolve) => setTimeout(() => resolve(HUNG), 4_000));

  try {
    const consume = (async () => {
      for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1' })) {
        chunks.push(chunk);
      }
    })().catch((error) => {
      failure = error;
    });
    const outcome = await Promise.race([consume.then(() => 'DONE'), guard]);
    hung = outcome === HUNG;
  } finally {
    await conversation.close();
  }

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  if (hung) return { verdict: 'HUNG', text };
  if (failure === undefined) return { verdict: 'FINISHED', text };
  const kind = failure.kind ?? failure.bridgeKind;
  return { verdict: kind === 'timeout' ? 'TIMED_OUT' : 'FAILED', failure, text };
}

// ── 1. The turn must end ───────────────────────────────────────────────────────────
await check('a silent worker ends the turn instead of leaving it waiting', async () => {
  const { verdict } = await turn(120);
  assert.notEqual(verdict, 'HUNG', 'the turn was still waiting 4s after the silence began');
});

await check('a silent worker is reported as a timeout', async () => {
  const { verdict, failure } = await turn(120);
  assert.equal(verdict, 'TIMED_OUT', `verdict was ${verdict}: ${failure?.message ?? 'no failure'}`);
});

await check('the harness would retry a silent turn', async () => {
  const { failure } = await turn(120);
  const { isRetryableCode } = await import('../lib/failure.js');
  const { codeFor, kindOf } = await import('../lib/failure.js');
  const code = codeFor(kindOf(failure));
  assert.equal(isRetryableCode(code), true, `${code} is not retryable, so a stuck worker ends the turn`);
});

// ── 2. What did arrive is still delivered ─────────────────────────────────────────
await check('the text that arrived before the silence is not thrown away', async () => {
  const { text } = await turn(120);
  assert.equal(text, 'working…', `text was ${JSON.stringify(text)}`);
});

// ── 3. A healthy turn must never be cut short by the guard ────────────────────────
await check('a complete turn is not affected by a short idle deadline', async () => {
  process.env.FAKE_STOP_REASON = 'end_turn';
  const script = join(scratch, 'healthy.json');
  writeFileSync(script, JSON.stringify(['hi']));
  process.env.FAKE_DELTAS_FILE = script;
  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} },
    idleTimeoutMs: 120
  });
  const chunks = [];
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1' })) {
      chunks.push(chunk);
    }
  } finally {
    await conversation.close();
  }
  const failure = chunks.find((c) => c.type === 'error')?.error;
  assert.equal(failure, undefined, `a healthy turn was failed: ${failure?.message}`);
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'hi');
});

delete process.env.FAKE_STOP_REASON;
delete process.env.FAKE_DELTAS_FILE;
await new Promise((resolve) => setTimeout(resolve, 100));
rmSync(scratch, { recursive: true, force: true });

console.log(`\nqoder stall guard: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
