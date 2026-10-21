/**
 * A stand-in worker runtime that ends a turn with a chosen `result` frame.
 *
 * A real runtime's `result` frame has several shapes and the driver treats them
 * differently, so a test needs to produce each one on demand rather than hope a real
 * account hits it. The frame and any text to deliver first come from the
 * environment:
 *
 *   FAKE_RESULT_FRAME   JSON of the `result` frame to send
 *   FAKE_RESULT_TEXT    text to stream as one assistant delta before that frame
 *
 * The frame shape mirrors what Qoder CN 0.4.8 sends, including the fact that a
 * failure may carry `errors` and no `result` at all.
 */
import { createInterface } from 'node:readline';

const frame = JSON.parse(process.env.FAKE_RESULT_FRAME ?? '{"type":"result","subtype":"success","is_error":false}');
const text = process.env.FAKE_RESULT_TEXT ?? '';
let replied = false;

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
        response: {
          models: [{ id: 'fake-model-1', name: 'Fake Model 1', contextWindow: 1000, maxTokens: 100 }]
        }
      }
    });
    return;
  }
  if (message?.type !== 'user' || replied) return;
  replied = true;

  // Anthropic-shaped streaming, which is what `--include-partial-messages` yields.
  write({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text }
    }
  });
  write({
    type: 'stream_event',
    event: { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 2 } }
  });
  write(frame);
});
