/**
 * A stand-in worker runtime for tests that must not need Qoder installed.
 *
 * It speaks just enough of the control channel for `QoderSession`: it answers
 * `initialize`, and it answers `get_models` with a roster whose size grows on
 * every call. That growth is the point — a catalog that is being re-read shows it,
 * and a frozen one does not, so a test can tell the two apart without a real
 * account.
 *
 * Every line received is appended to `FAKE_RUNTIME_LOG` as either `<type>` or
 * `control_request:<subtype>`. That log is how a test observes what the driver
 * actually sent — including whether a prompt went out at all.
 *
 * Environment:
 *   FAKE_MODELS_FIRST   how many models the first listing reports (default 1)
 *   FAKE_RUNTIME_LOG    append one line per received message to this file
 */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

// The spawn line is the only place a reasoning level or an emptied tool belt can be observed:
// by the time a message arrives on stdin those decisions are already baked into the process.
// Recorded to the same log the message trace uses, prefixed so a reader can tell them apart.
if (process.env.FAKE_RUNTIME_LOG !== undefined) {
  appendFileSync(process.env.FAKE_RUNTIME_LOG, `ARGV ${JSON.stringify(process.argv.slice(2))}\n`);
}

const models = Number(process.env.FAKE_MODELS_FIRST ?? '1') || 1;
const logFile = process.env.FAKE_RUNTIME_LOG;
let listings = 0;

function reply(requestId, response) {
  process.stdout.write(
    `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`
  );
}

function roster(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `fake-model-${index + 1}`,
    name: `Fake Model ${index + 1}`,
    contextWindow: 1000,
    maxTokens: 100
  }));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (logFile !== undefined) {
    const label =
      message?.type === 'control_request' ? `control_request:${message.request?.subtype}` : String(message?.type);
    appendFileSync(logFile, `${label}\n`);
  }
  if (message?.type !== 'control_request') return;
  const subtype = message.request?.subtype;

  if (subtype === 'initialize') {
    reply(message.request_id, { models: roster(models) });
    return;
  }
  if (subtype === 'get_models') {
    listings += 1;
    reply(message.request_id, { models: roster(models + listings - 1) });
    return;
  }
  reply(message.request_id, {});
});
