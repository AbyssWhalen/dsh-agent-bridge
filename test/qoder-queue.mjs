/**
 * A turn parked in the vendor's model queue must not be silent.
 *
 * Measured on 2026-10-27 against `dfmodel`: the worker sent nothing but `model_queue_status`
 * heartbeats for six minutes —
 *
 *     {"type":"system","subtype":"model_queue_status","status":"queued",
 *      "queue_count":9741,"wait_time_ms":3261000,...,"queue_wait_elapsed_ms":0}
 *
 * — the account was charged for each attempt, no chunk reached the caller, and the turn never
 * failed. Two separate faults, both fixed here:
 *
 *   1. The heartbeat reset the stall deadline like any other frame, so the five-minute idle
 *      timeout could not fire. A queued turn hung for as long as the queue was long — and
 *      the service advertises `queue_max_wait_ms` of an hour.
 *   2. The frame carried the position and the estimated wait, and both were discarded. The
 *      caller had no way to tell "waiting behind 9741 requests" from "wedged", which is the
 *      worst possible pair of explanations to confuse.
 *
 * Every frame used below is the captured shape, unedited except for the one field each case
 * varies. A tidied fixture would hide the field names this file depends on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QoderConversation, QUEUE_WAIT_BUDGET_MS, TURN_IDLE_TIMEOUT_MS, queueSentence } from '../drivers/qoder/conversation.js';

/** The captured frame's constants, as they arrived. */
const CAPTURED = { queue_count: 9741, wait_time_ms: 3261000, queue_max_wait_ms: 3600000 };

const scratch = mkdtempSync(join(tmpdir(), 'dsh-queue-'));

/**
 * Run one turn through a worker that queues first and answers afterwards.
 *
 * @param {{elapsed: number[], deltas?: string[], result?: string}} script
 * @returns {Promise<{text: string, chunks: object[], failure: any, notices: string[]}>}
 */
async function turn(script) {
  const file = join(scratch, `q-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script.deltas ?? []));
  process.env.FAKE_DELTAS_FILE = file;
  process.env.FAKE_QUEUE_ELAPSED = JSON.stringify(script.elapsed);
  process.env.FAKE_RESULT = script.result ?? '';
  delete process.env.FAKE_SPLIT;
  delete process.env.FAKE_THINKING;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    // Short, so the stalled-deadline path cannot be what ends the turn: only the queue
    // budget may do that, and a test that let the idle timeout fire would prove nothing.
    idleTimeoutMs: 60_000,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });

  const chunks = [];
  const notices = [];
  let failure;
  try {
    // Bounded, because one of these cases is a turn that is supposed to *not* end. Without a
    // bound, a regression in the budget makes this file hang rather than fail — and a hang
    // reads as infrastructure trouble, which is the one thing a red test must never be
    // mistaken for.
    const run = (async () => {
      for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1', effort: 'low' })) {
        chunks.push(chunk);
        if (chunk.type === 'text-delta' && /queued behind/u.test(chunk.text ?? '')) notices.push(chunk.text);
      }
    })();
    const bound = new Promise((resolve) => setTimeout(() => resolve('HUNG'), 20_000));
    if ((await Promise.race([run, bound])) === 'HUNG') {
      failure = { kind: 'hung', message: 'the turn never ended within 20s — the queue budget did not release it' };
    }
  } catch (error) {
    // The driver throws its marked error; the adapter is what turns it into an `LlmError`
    // with a code. Both layers are asserted below, each where the fact actually lives.
    failure = { kind: error?.bridgeKind, message: String(error?.message ?? error) };
  } finally {
    // The worker is a real child. Left open it keeps the process alive for minutes after the
    // assertions have already finished, which makes every run look slow and hides hangs.
    await conversation.close?.();
  }
  return { text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), chunks, failure, notices };
}

test('the sentence names the position and the wait, in units a person reads', () => {
  const sentence = queueSentence({ queueCount: CAPTURED.queue_count, waitMs: CAPTURED.wait_time_ms });
  assert.match(sentence, /9741/u, `the queue position is missing: ${sentence}`);
  assert.match(sentence, /54 minutes/u, `the wait is missing or unformatted: ${sentence}`);
  // The raw millisecond figure is not a duration to a reader, and printing it is the
  // silence this fix replaces with an answer.
  assert.doesNotMatch(sentence, /3261000|3600000/u, `raw milliseconds leaked: ${sentence}`);
});

test('the sentence is grammatical at the edges', () => {
  assert.equal(queueSentence({ queueCount: 1, waitMs: 60_000 }), "qoder: queued behind the vendor's model — 1 request ahead, roughly 1 minute to go");
  assert.equal(queueSentence({ queueCount: 5 }), "qoder: queued behind the vendor's model — 5 requests ahead");
  assert.equal(queueSentence({ waitMs: 120_000 }), "qoder: queued behind the vendor's model — roughly 2 minutes to go");
  assert.equal(queueSentence({}), 'qoder: waiting in the model queue');
  // Zero means "no queue", not "zero requests ahead".
  assert.equal(queueSentence({ queueCount: 0, waitMs: 0 }), 'qoder: waiting in the model queue');
});

test('the budget sits between the idle timeout and the service maximum', () => {
  // The relationship is the fix. Below the idle timeout the budget would be unreachable — the
  // stall guard would fire first and this path would never run. Above the service's own
  // maximum it would fire after the caller had already given up, and the hang would be back.
  assert.ok(QUEUE_WAIT_BUDGET_MS > TURN_IDLE_TIMEOUT_MS, `budget ${QUEUE_WAIT_BUDGET_MS} does not outlast the idle timeout ${TURN_IDLE_TIMEOUT_MS}`);
  assert.ok(QUEUE_WAIT_BUDGET_MS < CAPTURED.queue_max_wait_ms, `budget ${QUEUE_WAIT_BUDGET_MS} exceeds the service maximum ${CAPTURED.queue_max_wait_ms}`);
});

test('a queued turn says so once, then fails retryable on the budget', async () => {
  const { text, failure, notices } = await turn({
    // The heartbeat repeats every few seconds in life; four is enough to prove de-duplication.
    elapsed: [0, 30_000, 60_000, QUEUE_WAIT_BUDGET_MS + 1],
    deltas: ['never reached']
  });

  assert.equal(notices.length, 1, `the caller was told ${notices.length} times instead of once: ${JSON.stringify(notices)}`);
  assert.match(text, /9741/u, `the notice never reached the caller: ${JSON.stringify(text)}`);
  assert.notEqual(failure, undefined, 'the turn did not end; a queued turn past the budget must not hang');
  // The driver's own marking, which is what the adapter reads to choose the code.
  assert.equal(failure.kind, 'timeout', `expected the timeout kind, got ${failure.kind}: ${failure.message}`);
  assert.match(failure.message, /9741/u, `the failure does not say where the turn was: ${failure.message}`);
  assert.match(failure.message, /retry the turn/u, `the failure does not say what to do: ${failure.message}`);
});

test('the driver-level timeout kind becomes a retryable TIMEOUT code', async () => {
  // The second half of the same claim, asserted where it is implemented: a `timeout` kind
  // reaching the adapter must produce a code the harness will retry. Without this the turn
  // would fail with an internal error and the wait would still be a dead end for the caller.
  const { toLlmError } = await import('../lib/llm-error.js');
  const { isRetryableCode } = await import('../lib/failure.js');
  const { noticedFailure } = await import('../lib/failure.js');

  const failure = toLlmError(noticedFailure('qoder: queued; retry the turn', 'timeout'), 'qoder');
  assert.equal(failure.code, 'TIMEOUT', `kinds resolve to codes elsewhere; this path drifted: ${failure.code}`);
  assert.equal(isRetryableCode(failure.code), true, `TIMEOUT is expected to be retryable, but the harness will not retry it`);
});

test('a queue that clears in time answers normally, with the same single notice', async () => {
  const { text, failure, notices } = await turn({
    elapsed: [0, 20_000],
    deltas: ['Done.'],
    result: 'Done.'
  });

  assert.equal(failure, undefined, `a served turn must not fail: ${failure?.message}`);
  assert.equal(notices.length, 1, `expected one notice, got ${notices.length}`);
  assert.match(text, /Done\./u, `the answer was lost: ${JSON.stringify(text)}`);
});

test('a turn that is never queued says nothing about queues', async () => {
  // The notice must be caused by the queue frame, not printed on every turn. An
  // unconditional line would be noise in exactly the case that needs no explanation.
  const { text, failure, notices } = await turn({ elapsed: [], deltas: ['Plain answer.'], result: 'Plain answer.' });
  assert.equal(notices.length, 0, `a normal turn mentioned the queue: ${JSON.stringify(notices)}`);
  assert.equal(failure, undefined);
  assert.equal(text, 'Plain answer.');
});
