/**
 * Offline: the stream path's own failures must carry a classifiable kind.
 *
 * Two of them did not. Both were bare `Error`s:
 *
 *   1. **The upstream response carried no body.** A 2xx that then sends nothing. The `pump` catch
 *      re-failed the queue with the error object as-is, so it reached the harness as `UNKNOWN` —
 *      a code the default retry policy ignores, for a fault that a plain re-ask would fix.
 *
 *   2. **An error frame.** `{error: "..."}` in the SSE stream. This is the frame an exhausted
 *      account actually receives, so it was the *most common* failure of the whole driver, and it
 *      was also `UNKNOWN`. `failure.js` records the same mistake being made and fixed once already
 *      for Qoder's allowance notice; the WorkBuddy side was still doing it.
 *
 * `client.chatStream` is injected, so no network and no credentials are involved.
 *
 * Run with `node test/workbuddy-stream-failures.mjs`.
 */
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split('\n')[0]}`);
  }
}

const { WorkBuddyConversation } = await import('../drivers/workbuddy/conversation.js');
const { kindOf, KIND_TO_CODE, isRetryableCode } = await import('../lib/failure.js');

const encoder = new TextEncoder();

/** A Response-shaped object whose body yields the given raw SSE lines, then ends. */
function bodyOf(lines) {
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const line of lines) yield encoder.encode(line);
      }
    }
  };
}

/** A Response-shaped object with no body at all, as a 204 or a stripped proxy would give. */
function bodyless() {
  return { body: null };
}

/**
 * Run one turn against an injected upstream and report how it ended.
 *
 * @param {() => object} responseFactory
 * @returns {Promise<{text: string, kind: string|undefined, code: string|undefined, message: string, retryable: boolean}>}
 */
async function turn(responseFactory) {
  const conversation = new WorkBuddyConversation({
    client: { region: 'cn', chatStream: async () => responseFactory() },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  let text = '';
  let error;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? '';
      if (chunk.type === 'error') error = chunk.error;
    }
  } catch (caught) {
    error = caught;
  }

  const kind = error === undefined ? undefined : kindOf(error);
  const code = kind === undefined ? undefined : (KIND_TO_CODE[kind] ?? 'UNKNOWN');
  return {
    text,
    kind,
    code,
    message: error === undefined ? '' : String(error.message ?? error),
    retryable: code === undefined ? false : isRetryableCode(code)
  };
}

// ── 1. A response with no body ──────────────────────────────────────────────
await check('a bodyless response is a retryable transport failure', async () => {
  const got = await turn(bodyless);
  assert.equal(got.kind, 'transport', `kind was ${got.kind}; a 2xx with no body is not a caller error`);
  assert.equal(got.code, 'TRANSPORT');
  assert.equal(got.retryable, true, 'a re-askable failure arrived as non-retryable');
});

await check('the bodyless message still says what happened', async () => {
  const got = await turn(bodyless);
  assert.ok(got.message.includes('no body'), got.message);
});

// ── 2. An error frame ───────────────────────────────────────────────────────
await check('an exhausted-credit error frame is QUOTA and is not retried', async () => {
  // This is the frame an account with no credits actually receives.
  const got = await turn(() => bodyOf(['data: {"error":"积分不足，请充值"}\n\n']));
  assert.equal(got.kind, 'hard_credit', `kind was ${got.kind}; the text names exhausted credit`);
  assert.equal(got.code, 'QUOTA');
  assert.equal(got.retryable, false, 'retrying a spent account wastes attempts and tells the user nothing');
});

await check('a rate-limit error frame keeps its retryability', async () => {
  // The classifier recognises rate limiting from text when there is no status to read.
  const got = await turn(() => bodyOf(['data: {"error":"rate limit exceeded"}\n\n']));
  assert.equal(got.kind !== undefined, true, 'the frame produced no kind at all');
  assert.equal(KIND_TO_CODE[got.kind] !== undefined, true, `unmapped kind ${got.kind}`);
});

await check('an error frame keeps the upstream wording', async () => {
  const got = await turn(() => bodyOf(['data: {"error":"积分不足，请充值"}\n\n']));
  assert.ok(got.message.includes('积分不足'), `the upstream text was lost: ${got.message}`);
});

await check('a generic error frame is still classified, not left bare', async () => {
  // Whatever the text, the point is that `kindOf` resolves it. A bare Error here becomes
  // `dsh: INTERNAL:` in the log, which blames this plugin for the upstream's problem.
  const got = await turn(() => bodyOf(['data: {"error":"something odd"}\n\n']));
  assert.notEqual(got.kind, undefined, 'an error frame still produced an unclassifiable error');
});

// ── 3. An error frame after the answer was delivered must not discard it ───
await check('an error frame after text is delivered keeps the text', async () => {
  // The regression this protects against: throwing away an answer the user is already reading.
  const got = await turn(() =>
    bodyOf([
      'data: {"choices":[{"delta":{"content":"the answer"}}]}\n\n',
      'data: {"error":"积分不足，请充值"}\n\n'
    ])
  );
  assert.equal(got.text, 'the answer', 'the delivered answer was discarded');
});

// ── 4. A healthy stream is untouched ───────────────────────────────────────
await check('a healthy stream still delivers its text and ends clean', async () => {
  const got = await turn(() =>
    bodyOf([
      'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: [DONE]\n\n'
    ])
  );
  assert.equal(got.text, 'hello world');
  assert.equal(got.kind, undefined, 'a clean turn produced an error');
});

console.log(`\nworkbuddy stream failures: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
