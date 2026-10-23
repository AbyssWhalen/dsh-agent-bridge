/**
 * Offline: an upstream body that is not an envelope must still be classified.
 *
 * The chat path already classified correctly: `sendJson` reads the body, calls
 * `classifyUpstreamError` and throws an `UpstreamFailure` carrying a `kind` (upstream.js, the
 * `!response.ok` branch). The auxiliary paths — token refresh, model list, credits — went through
 * `readEnvelope` instead, which threw a bare `Error` whose only record of the kind was a word in
 * the message string.
 *
 * The consequence was not cosmetic. `kindOf` cannot classify a bare error, so it reached the
 * harness as `UNKNOWN`; `UNKNOWN` is not in the default retry set. A gateway 502 — the single most
 * retryable failure there is — arrived as a hard, non-retryable failure, and the log said
 * `dsh: INTERNAL: workbuddy upstream returned non-JSON`, which reads like a bug in this plugin at
 * exactly the moment the upstream is what is broken. `failure.js` already documented this class of
 * mistake for Qoder's allowance notice; this is the same mistake on the WorkBuddy side.
 *
 * Run with `node test/workbuddy-envelope.mjs`.
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

const { readEnvelope, envelopeError, classifyUpstreamError } = await import('../drivers/workbuddy/upstream.js');
const { kindOf, KIND_TO_CODE, isRetryableCode } = await import('../lib/failure.js');

/** Read a response and report what the harness would make of the failure, if it failed. */
async function classifyBody(status, body) {
  try {
    await readEnvelope(new Response(body, { status }));
    return { threw: false };
  } catch (error) {
    const kind = kindOf(error);
    const code = kind === undefined ? 'UNKNOWN' : (KIND_TO_CODE[kind] ?? 'UNKNOWN');
    return { threw: true, kind, code, retryable: isRetryableCode(code), message: error.message };
  }
}

// ── The regression that motivated this file ────────────────────────────────
await check('a gateway 502 HTML page is a retryable server failure', async () => {
  const got = await classifyBody(502, '<html><body>502 Bad Gateway</body></html>');
  assert.equal(got.threw, true, 'an HTML body was accepted as an envelope');
  assert.equal(got.kind, 'server', `kind was ${got.kind}; a 5xx is the upstream being unwell`);
  assert.equal(got.code, 'SERVER');
  assert.equal(got.retryable, true, 'a 502 arrived as non-retryable, so the harness will not retry it');
});

await check('a 503 with an empty body is retryable too', async () => {
  const got = await classifyBody(503, '');
  assert.equal(got.kind, 'server');
  assert.equal(got.retryable, true);
});

await check('the excerpt survives, because it is what names the gateway', async () => {
  const got = await classifyBody(502, '<html>502 Bad Gateway from nginx</html>');
  assert.ok(
    got.message.includes('502 Bad Gateway from nginx'),
    `the body was dropped from the message: ${got.message}`
  );
  assert.ok(got.message.includes('http 502'), 'the status vanished from the message');
});

// ── The other statuses must not be swept into "retryable" ──────────────────
await check('a 403 with a text body is a client error and is not retried', async () => {
  const got = await classifyBody(403, 'Blocked by policy');
  assert.equal(got.kind, 'client');
  assert.equal(got.code, 'BAD_REQUEST');
  assert.equal(got.retryable, false);
});

await check('a 401 HTML login page is a dead session, not a retryable fault', async () => {
  const got = await classifyBody(401, '<html>please sign in</html>');
  assert.equal(got.kind, 'session_dead');
  assert.equal(got.code, 'INVALID_CREDENTIAL');
  assert.equal(got.retryable, false);
});

await check('a 402 is exhausted credit, not a transport fault', async () => {
  const got = await classifyBody(402, '<html>payment required</html>');
  assert.equal(got.kind, 'hard_credit');
  assert.equal(got.code, 'QUOTA');
  assert.equal(got.retryable, false);
});

await check('a 429 carrying a JSON array is rate limiting, not a parse failure', async () => {
  // The body parses as JSON but is not an object. Classifying it by status keeps the retry.
  const got = await classifyBody(429, '[1,2,3]');
  assert.equal(got.threw, true);
  assert.equal(got.kind, 'soft_rate');
  assert.equal(got.code, 'RATE_LIMIT');
  assert.equal(got.retryable, true);
});

await check('a non-object JSON document is still a failure', async () => {
  const got = await classifyBody(200, '"just a string"');
  assert.equal(got.threw, true, 'a bare JSON string was accepted as an envelope');
  assert.ok(got.message.includes('unexpected document'), got.message);
});

// ── The business-code path ─────────────────────────────────────────────────
await check('envelopeError carries its kind in a field, not only in prose', async () => {
  const error = envelopeError(502, { code: 500, msg: 'backend exploded' });
  assert.equal(kindOf(error), 'server', 'the kind was lost when only the message mentioned it');
  assert.equal(isRetryableCode(KIND_TO_CODE[kindOf(error)]), true);
});

await check('a business-code failure keeps the upstream message', async () => {
  const error = envelopeError(402, { code: 402, msg: '余额不足，请充值' });
  assert.ok(error.message.includes('余额不足'), error.message);
  assert.equal(kindOf(error), 'hard_credit');
});

await check('a 200 envelope with a non-zero business code still fails', async () => {
  // The upstream's own convention: HTTP 200, code !== 0. `readEnvelope` must not treat it as ok.
  const envelope = await readEnvelope(new Response(JSON.stringify({ code: 400, msg: 'bad' }), { status: 200 }));
  assert.equal(envelope.code, 400);
  const error = envelopeError(200, envelope);
  assert.equal(kindOf(error) !== undefined, true, 'the failure carried no kind at all');
});

// ── A healthy envelope is untouched ───────────────────────────────────────
await check('a well-formed envelope still parses', async () => {
  const envelope = await readEnvelope(
    new Response(JSON.stringify({ code: 0, msg: '', data: { models: [{ id: 'm' }] } }), { status: 200 })
  );
  assert.equal(envelope.code, 0);
  assert.deepEqual(envelope.data, { models: [{ id: 'm' }] });
});

await check('readEnvelope and classifyUpstreamError agree on every status it handles', async () => {
  // Parity: if the classifier says one thing and the envelope path another, the same upstream
  // failure is retryable or not depending on which endpoint happened to be called.
  for (const status of [401, 402, 404, 429, 500, 502, 503]) {
    const got = await classifyBody(status, 'not json at all');
    const expected = classifyUpstreamError(status, 'not json at all');
    assert.equal(got.kind, expected, `status ${status}: envelope said ${got.kind}, classifier said ${expected}`);
  }
});

console.log(`\nworkbuddy envelope: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
