/**
 * A stand-in worker runtime that records what each turn actually sent.
 *
 * The two questions this answers are both about **volume**, which a rendered reply
 * cannot show:
 *
 * 1. What framing did the child get? `QoderSession.initialize()` sends the system
 *    prompt once, and `toolPreamble()` is appended to it when tools are advertised.
 *    Whether the adapter's "you have no tools" preamble is in there too is a fact
 *    about bytes, not about behaviour — a model can behave fine while being told two
 *    contradictory things, and then behave badly later for a reason nobody traces
 *    back. So the framing is recorded verbatim.
 *
 * 2. How big is each turn's prompt? `QoderConversation.send()` appends one message
 *    when history grew by a single user turn, and replays the whole transcript
 *    otherwise. Which branch ran is invisible from the reply, and it is the only way
 *    to price the rebuild.
 *
 * Every user message is answered with text from `FAKE_REPLY`, so a caller can drive
 * several turns. The log is one JSON object per line:
 *
 *   {"kind":"framing","bytes":1234,"text":"…"}
 *   {"kind":"prompt","turn":1,"bytes":12,"replay":false,"text":"…"}
 *
 * Environment:
 *   FAKE_MEASURE_LOG   append the JSONL described above to this file
 *   FAKE_REPLY         text streamed for every turn (default "ok")
 *   FAKE_REPLY_FRAMES  comma-separated per-turn overrides; turn N uses item N-1,
 *                      falling back to FAKE_REPLY when the list runs out
 */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const logFile = process.env.FAKE_MEASURE_LOG;
const overrides = (process.env.FAKE_REPLY_FRAMES ?? '')
  // Split on a delimiter a reply can never contain by accident: the reply is model
  // markup, and a comma-count would make the list depend on the prose inside it.
  .split('|||')
  .map((piece) => piece.trim())
  .filter((piece) => piece.length > 0);
const defaultReply = process.env.FAKE_REPLY ?? 'ok';
let turn = 0;

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
    // The caller's request payload carries the framing, so it is recorded from the
    // request rather than guessed at from the driver's source.
    if (message.request?.subtype === 'initialize') {
      // `#request()` spreads the payload beside `subtype`, so the framing sits at
      // `request.systemPrompt`. The nested form is checked too because a future
      // runtime could wrap it, and a silent zero-byte framing reads as "not sent".
      const framing =
        message.request?.systemPrompt ??
        message.request?.request?.systemPrompt ??
        message.request?.system ??
        message.request?.prompt ??
        '';
      record({ kind: 'framing', bytes: Buffer.byteLength(String(framing)), text: String(framing) });
    }
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

  if (message?.type !== 'user') return;
  turn += 1;

  const text = String(message.message?.content ?? message.content ?? '');
  record({
    kind: 'prompt',
    turn,
    bytes: Buffer.byteLength(text),
    // A replayed transcript is wrapped by `flattenConversation`, and that wrapper is
    // the only thing that distinguishes it from an appended single turn.
    replay: text.startsWith('[Conversation so far]'),
    text
  });

  const reply = overrides[turn - 1] ?? defaultReply;
  write({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }
  });
  write({
    type: 'stream_event',
    event: { type: 'message_delta', usage: { input_tokens: 10, output_tokens: 2 } }
  });
  write({ type: 'result', subtype: 'success', is_error: false, result: reply });
});
