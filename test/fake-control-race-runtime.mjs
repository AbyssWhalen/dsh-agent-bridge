/**
 * A stand-in worker that asks the host for a job token and then dies while the host
 * is still minting it.
 *
 * `#answerControl()` awaits `resolveCredential()` and then a network round trip, and
 * the reply is written with `void this.#answerControl(message)` — nobody holds the
 * promise. So if the child disappears during that wait, the reply cannot be written,
 * and the question is what the *second* failed write does: the `catch` block writes a
 * `subtype: 'error'` response through the same throwing path.
 *
 * An unhandled rejection is not a lost log line. On current Node it terminates the
 * process by default, so a worker that dies at the wrong moment takes the whole DSH
 * host down with it.
 *
 * Environment:
 *   CTRL_DELAY_MS   how long the fake waits before dying (longer than the token mint)
 *   CTRL_EXIT_CODE  exit status (default 9)
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

  // Ask for the token, then die. The host's reply has nowhere to go.
  write({ type: 'control_request', request_id: 'ctrl-token-1', request: { subtype: 'fetch_job_token', reason: 'turn' } });
  setTimeout(() => process.exit(Number(process.env.CTRL_EXIT_CODE ?? '9')), Number(process.env.CTRL_DELAY_MS ?? '60'));
});
