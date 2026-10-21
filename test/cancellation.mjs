/**
 * Offline: a cancelled turn is reported as a cancellation, not as an upstream fault.
 *
 * The distinction is not cosmetic. A `kind` of `server` is what makes the harness
 * consider a retry, so a user pressing stop could have their turn re-sent; and the
 * message they see — "the upstream rejected the request (server, http 0)" — sends
 * them looking for an upstream problem that does not exist. The status code `0` was
 * invented by the driver, which is its own reason not to report it.
 *
 * Both places a cancellation can land are covered: the request, and the body read.
 * `fetch` is replaced for this test, so no network is involved.
 *
 * Run with `node test/cancellation.mjs`.
 */
import { UpstreamFailure, UpstreamClient, classifyUpstreamError, describeFailure } from '../drivers/workbuddy/upstream.js';
import { WorkBuddyConversation } from '../drivers/workbuddy/conversation.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const realFetch = globalThis.fetch;
const credential = {
  accessToken: 'test-token',
  refreshToken: 'test-refresh',
  uid: 'u1',
  domain: '',
  enterpriseId: ''
};

/** Replace fetch for the duration of one case. */
async function withFetch(implementation, run) {
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

// --- the request path -------------------------------------------------------
console.log('\ncancelled before the response');
{
  const controller = new AbortController();
  controller.abort();
  const client = new UpstreamClient({ region: 'cn' });

  const failure = await withFetch(
    async () => {
      throw abortError();
    },
    () =>
      client
        .chatStream(credential, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, controller.signal)
        .then(() => undefined)
        .catch((error) => error)
  );

  check('the failure is a cancellation', failure?.kind === 'cancelled', String(failure?.kind));
  check('it is recognisable as an upstream failure type', failure instanceof UpstreamFailure);
  check('no invented status code is reported', failure?.status === 0);
  check(
    'the message says cancelled, not rejected',
    /cancelled/u.test(String(failure?.message)) && !/rejected/u.test(String(failure?.message)),
    String(failure?.message)
  );
  check('the retry hint is absent', failure?.retryAfterSec === undefined);
}

console.log('\na real transport fault is still a server fault');
{
  const client = new UpstreamClient({ region: 'cn' });
  const failure = await withFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    () =>
      client
        .chatStream(credential, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)
        .then(() => undefined)
        .catch((error) => error)
  );
  check('a network error stays a server failure', failure?.kind === 'server', String(failure?.kind));
  check('and it keeps the diagnostic detail', /fetch failed/u.test(String(failure?.message)), String(failure?.message));
}

// --- the body-read path -----------------------------------------------------
console.log('\ncancelled while the body is being read');
{
  const controller = new AbortController();
  const client = new UpstreamClient({ region: 'cn' });

  const chunks = [];
  let failure;
  await withFetch(
    async () => {
      // A response whose body throws once reading starts, which is what an abort
      // mid-stream looks like to the reader.
      const body = new ReadableStream({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"He"}}]}\n'));
          // The abort lands here, as it would when the user presses stop.
          controller.abort();
          streamController.error(abortError());
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    async () => {
      const conversation = new WorkBuddyConversation({
        client,
        resolveCredential: async () => credential,
        logger: { debug: () => {}, warn: () => {} }
      });
      try {
        for await (const chunk of conversation.send([{ role: 'user', text: 'hi' }], {
          model: 'm',
          signal: controller.signal
        })) {
          chunks.push(chunk.type);
        }
      } catch (error) {
        failure = error;
      }
    }
  );

  check('the mid-stream failure is a cancellation', failure?.kind === 'cancelled', String(failure?.kind));
  check('nothing was reported as an upstream rejection', !/rejected/u.test(String(failure?.message)), String(failure?.message));
}

// --- classification is unchanged for real statuses ---------------------------
console.log('\nreal upstream failures keep their classes');
check('402 stays hard_credit', classifyUpstreamError(402, '') === 'hard_credit');
check('401 stays session_dead', classifyUpstreamError(401, '') === 'session_dead');
check('429 stays soft_rate', classifyUpstreamError(429, '') === 'soft_rate');
check('500 stays server', classifyUpstreamError(500, '') === 'server');
check(
  'a cancellation sentence reads as a cancellation',
  /cancelled/u.test(describeFailure('cancelled', 0, '')),
  describeFailure('cancelled', 0, '')
);

const failed = results.filter((result) => !result.ok);
console.log(`\ncancellation: ${failed.length === 0 ? 'OK' : `${failed.length} FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
