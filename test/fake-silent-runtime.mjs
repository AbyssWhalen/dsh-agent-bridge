/**
 * A worker runtime that answers a turn with one delta and then goes quiet.
 *
 * It never sends a `result` frame, so a turn against it only ends when something else ends it.
 * That is the shape a host-side `close()` has to handle: the child is killed, no further event
 * can arrive, and whatever is waiting on the turn has to be told rather than left waiting.
 */
import { createInterface } from 'node:readline';

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

  write({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working…' } }
  });
  // Deliberately no `result` frame. Stay alive and silent.
});
