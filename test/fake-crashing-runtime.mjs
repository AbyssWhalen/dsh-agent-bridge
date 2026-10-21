/**
 * A stand-in worker that dies after its first turn.
 *
 * The failure being probed is "the child is gone but the driver still thinks it is
 * ready". Two things must be observable for that to be diagnosable:
 *
 *   1. whether the next turn throws, hangs, or quietly reports success;
 *   2. whether the prompt the next turn sends is an append (which assumes the child
 *      still remembers the conversation) or a replay (which does not).
 *
 * So this records every prompt it receives before dying, and `process.exit` is called
 * on the timer below rather than after a reply — a crash is not a clean end of turn.
 *
 * Environment:
 *   CRASH_LOG     append the received prompts to this file as JSONL
 *   CRASH_AFTER   exit after this many completed turns (default 1)
 *   CRASH_REPLY   text streamed for each turn (default "ok")
 *   CRASH_PIDLOG  write the child pid here, so a caller can prove a replacement happened
 */
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';

const logFile = process.env.CRASH_LOG;
const pidLog = process.env.CRASH_PIDLOG;
const crashAfter = Number(process.env.CRASH_AFTER ?? '1');
const reply = process.env.CRASH_REPLY ?? 'ok';
let turn = 0;

if (pidLog !== undefined) {
  try {
    appendFileSync(pidLog, `${process.pid}\n`);
  } catch {
    /* a diagnostic that breaks the thing it diagnoses is not worth having */
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record(entry) {
  if (logFile === undefined) return;
  appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message?.type === 'control_request') {
    write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: { models: [{ id: 'fake-model-1', name: 'Fake Model 1', contextWindow: 1000, maxTokens: 100 }] }
      }
    });
    // Answer the initialize, and carry on: dying on a timer here would race the turn's own
    // reply, so the deterministic death is the `on-command` mode below.
    return;
  }

  if (message?.type !== 'user') return;
  turn += 1;
  const text = String(message.message?.content ?? message.content ?? '');
  record({ turn, bytes: Buffer.byteLength(text), replay: text.startsWith('[Conversation so far]'), text });

  // Die on demand, with no reply. Deterministic where a timer is not: a test that wants a
  // session whose child is gone can ask for it rather than wait for a race to land.
  if (process.env.CRASH_MODE === 'on-command' && text.includes(process.env.CRASH_COMMAND ?? 'exit-now')) {
    setTimeout(() => process.exit(9), Number(process.env.CRASH_DELAY_MS ?? '20'));
    return;
  }

  if (turn >= crashAfter && process.env.CRASH_MODE === 'mid-turn') {
    // Die after partial output and before any `result` frame: the turn is interrupted
    // rather than the child dying between turns, and the caller must learn about it.
    write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } });
    setTimeout(() => process.exit(9), Number(process.env.CRASH_DELAY_MS ?? '80'));
    return;
  }

  if (turn >= crashAfter) {
    // Answer the turn, then die without the clean shutdown the child normally does.
    write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
    write({ type: 'result', subtype: 'success', is_error: false, result: reply });
    setTimeout(() => {
      process.stderr.write('fake: crashing\n');
      process.exit(9);
    }, Number(process.env.CRASH_DELAY_MS ?? '120'));
    return;
  }

  write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
  write({ type: 'result', subtype: 'success', is_error: false, result: reply });
});
