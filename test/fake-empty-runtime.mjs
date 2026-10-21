/**
 * A stand-in worker runtime that never reports a model.
 *
 * The empty answer is a real state — an account that is not signed in yet — and the
 * provider is hidden while it lasts. Caching it would keep the group hidden after
 * the user signed in, so the driver has to keep asking. This runtime makes "did it
 * ask again" observable by logging each request.
 */
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const logFile = process.env.FAKE_RUNTIME_LOG;

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.type !== 'control_request') return;
  const subtype = message.request?.subtype;
  if (logFile !== undefined) appendFileSync(logFile, `empty:${subtype}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id, response: { models: [] } }
    })}\n`
  );
});
