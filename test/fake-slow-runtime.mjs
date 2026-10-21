/**
 * A stand-in worker runtime that accepts a prompt and then never finishes the turn.
 *
 * This is the shape a real turn has while it is streaming: the child has the prompt
 * and owes a `result`. Nothing here produces one, so the only thing that can end the
 * turn is the host's own cancellation — which is exactly what a test needs to prove
 * that cancelling mid-turn interrupts the child instead of leaving it working.
 *
 * Environment:
 *   FAKE_RUNTIME_LOG    append one line per received message to this file
 */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const logFile = process.env.FAKE_RUNTIME_LOG;

function reply(requestId, response) {
  process.stdout.write(
    `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`
  );
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
    reply(message.request_id, {
      models: [{ id: 'slow-model', name: 'Slow Model', contextWindow: 1000, maxTokens: 100 }]
    });
    return;
  }
  // One thinking delta, then silence: the turn stays open.
  if (subtype === 'get_models') {
    reply(message.request_id, {
      models: [{ id: 'slow-model', name: 'Slow Model', contextWindow: 1000, maxTokens: 100 }]
    });
    return;
  }
  reply(message.request_id, {});
});
