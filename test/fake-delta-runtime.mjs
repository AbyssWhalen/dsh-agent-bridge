/**
 * A stand-in worker runtime that replies with a **scripted list of text deltas**.
 *
 * The split matters as much as the text. `QoderConversation` holds a tail only while
 * `endsWithMarkerPrefix()` says it could still become a marker, so the same characters
 * behave differently depending on where the deltas break: a boundary one character early
 * releases the opening of a call as prose, and the tool never runs. A test that feeds the
 * whole block in one string cannot see that — it exercises the batch parser, not the
 * stream.
 *
 * The script is a JSON array of strings in `FAKE_DELTAS_FILE`. A turn consumes from the
 * front; anything left over is repeated for later turns. `FAKE_SPLIT` splits a single
 * string into one-character deltas instead, which is the worst case for the hold logic.
 *
 * Environment:
 *   FAKE_DELTAS_FILE  path to a JSON array of delta strings
 *   FAKE_SPLIT        when set, the deltas are ignored and the joined script is cut into
 *                     single characters
 *   FAKE_RESULT       the `result` frame's text (default: the concatenated deltas)
 */
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

// The spawn line is the only place a reasoning level can be observed: by the time a message
// arrives on stdin that decision is already baked into the process. Recorded to the same log
// the message trace uses, prefixed so a reader can tell the two apart.
if (process.env.FAKE_RUNTIME_LOG !== undefined) {
  appendFileSync(process.env.FAKE_RUNTIME_LOG, `ARGV ${JSON.stringify(process.argv.slice(2))}\n`);
}

const scriptPath = process.env.FAKE_DELTAS_FILE;
const deltas = scriptPath === undefined ? [] : JSON.parse(readFileSync(scriptPath, 'utf8'));
const script = process.env.FAKE_SPLIT ? [...deltas.join('')] : deltas;
const resultText = process.env.FAKE_RESULT ?? deltas.join('');

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
    return;
  }

  if (message?.type !== 'user') return;

  for (const delta of script) {
    if (delta.length === 0) continue;
    write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } } });
  }
  // `stop_reason` rides `message_delta`, alongside the usage the driver already reads. A worker
  // that hit a token ceiling says `max_tokens` here, and that is the only place it says it.
  write({
    type: 'stream_event',
    event: { type: 'message_delta', delta: { stop_reason: process.env.FAKE_STOP_REASON ?? 'end_turn' }, usage: { output_tokens: 0 } }
  });
  write({ type: 'result', subtype: 'success', is_error: false, result: resultText });
});
