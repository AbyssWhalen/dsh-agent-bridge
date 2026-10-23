/**
 * How a failure reaches the harness, and whether the harness can still tell what it was.
 *
 * This is not a cosmetic check. The harness stores a failure's meaning only when the error it
 * catches is an `LlmError`:
 *
 *     turnEnds = { kind: 'error', error: error instanceof LlmError ? error.failure : { message, code: 'UNKNOWN' } }
 *
 * — `dsh-agent-loop`, in the turn's catch. Everything else becomes `code: 'UNKNOWN'`. That
 * code is what `dsh-llm-retry` matches against `retryableCodes` (default `EMPTY_RESPONSE`,
 * `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`), so an unclassified failure is never retried
 * even when it is exactly the transient thing retrying exists for.
 *
 * Measured live before this was written — a Qoder turn refused by the daily Chat limit came out
 * as, verbatim:
 *
 *     dsh: UNKNOWN: qoder: You've reached your daily usage limit for Chat. ...
 *
 * The message survived because it is carried as text; the meaning did not. A 429, a dead
 * session, an expired credential and a genuinely broken server were all `UNKNOWN` alike.
 *
 * The adapter is the last place that still knows the difference, so the conversion belongs
 * there and nowhere else: drivers stay free of harness types, and one mapping table covers both
 * of them.
 */
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { DriverAdapter } from '../lib/adapter.js';
import { UpstreamFailure } from '../drivers/workbuddy/upstream.js';
import { KIND_TO_CODE, codeFor, isRetryableCode } from '../lib/failure.js';
import { WorkBuddyConversation } from '../drivers/workbuddy/conversation.js';
import { QoderConversation } from '../drivers/qoder/conversation.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
let failed = 0;

const scratch = mkdtempSync(join(tmpdir(), 'dsh-taxonomy-'));

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

/**
 * Run one adapter turn against a driver whose session fails in a given way.
 *
 * @param {() => Error} makeError
 * @returns {Promise<Error>} whatever escaped the adapter
 */
async function escaped(makeError) {
  const adapter = new DriverAdapter({
    provider: 'fixture',
    displayName: 'Fixture',
    driver: {
      ownSystemPrompt: true,
      locate: async () => ({ installed: true, signedIn: true }),
      listModels: async () => [],
      openSession: async () => ({
        ready: true,
        close: async () => {},
        send: async function* () {
          throw makeError();
        }
      })
    },
    catalog: { models: async () => [] }
  });
  try {
    for await (const _chunk of adapter.stream({
      model: 'fixture-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    })) {
      // Nothing is expected to arrive; the turn fails before it can.
    }
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await adapter.close();
  }
}

/** The harness's own way of asking "what was this?". */
const codeOf = (error) => (error instanceof LlmError ? error.failure.code : 'UNKNOWN');
const isClassified = (error) => error instanceof LlmError;

// ── 1. The failure taxonomy has to survive the adapter ─────────────────────────────
const taxonomy = [
  ['soft_rate', new UpstreamFailure('soft_rate', 429, 'too many requests'), 'RATE_LIMIT'],
  ['server', new UpstreamFailure('server', 503, 'upstream is down'), 'SERVER'],
  ['hard_credit', new UpstreamFailure('hard_credit', 402, 'no credit left'), 'QUOTA'],
  ['session_dead', new UpstreamFailure('session_dead', 401, 'sign in again'), 'INVALID_CREDENTIAL'],
  ['not_found', new UpstreamFailure('not_found', 404, 'no such model'), 'NOT_FOUND'],
  ['client', new UpstreamFailure('client', 400, 'bad request'), 'BAD_REQUEST'],
  ['cancelled', new UpstreamFailure('cancelled', 0, 'the caller stopped it'), 'ABORTED']
];

for (const [kind, error, expected] of taxonomy) {
  await check(`a ${kind} failure reaches the harness as ${expected}`, async () => {
    const escapedError = await escaped(() => error);
    assert.notEqual(escapedError, undefined, 'the failure was swallowed');
    assert.ok(isClassified(escapedError), `${kind} arrived as ${escapedError?.name}, so the harness can only call it UNKNOWN`);
    assert.equal(codeOf(escapedError), expected, `code was ${codeOf(escapedError)}`);
  });
}

// ── 2. The message must survive the conversion ─────────────────────────────────────
await check('the conversion keeps the sentence the driver wrote', async () => {
  const escapedError = await escaped(() => new UpstreamFailure('soft_rate', 429, 'too many requests'));
  assert.match(String(escapedError?.message), /free-tier queue|too many requests|workbuddy/u, `message was ${JSON.stringify(escapedError?.message)}`);
});

// ── 3. A cancellation must not be retried, and must stay distinguishable ───────────
await check('a cancellation is ABORTED, not something the retry policy will replay', async () => {
  const escapedError = await escaped(() => new UpstreamFailure('cancelled', 0, 'the caller stopped it'));
  assert.equal(codeOf(escapedError), 'ABORTED');
  assert.equal(/RATE_LIMIT|SERVER|TIMEOUT|TRANSPORT/u.test(codeOf(escapedError)), false);
});

// ── 4. An empty turn is the one case worth retrying ────────────────────────────────
await check('an empty turn is reported as EMPTY_RESPONSE so the harness retries it', async () => {
  // F-027 made an empty turn a failure rather than a blank answer. Naming the reason is only
  // half of it: the harness retries `EMPTY_RESPONSE` by default and nothing else about a
  // contentless turn is retryable, so an unclassified code left the one recoverable case
  // unrecoverable.
  //
  // The session here is the **real** WorkBuddy conversation fed an empty SSE body, so the guard
  // being exercised is the shipped one. A fixture that threw a pre-marked error would only
  // prove the table maps, and stay green after a driver regressed to a bare `Error`.
  const adapter = new DriverAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    driver: {
      ownSystemPrompt: true,
      locate: async () => ({ installed: true, signedIn: true }),
      listModels: async () => [],
      openSession: async () =>
        new WorkBuddyConversation({
          client: {
            region: 'cn',
            chatStream: async () => ({
              body: {
                // A stream that ends cleanly having said nothing at all.
                async *[Symbol.asyncIterator]() {}
              }
            })
          },
          resolveCredential: async () => ({ token: 'x' }),
          logger: { debug() {}, warn() {} }
        })
    },
    catalog: { models: async () => [] }
  });
  let escapedError;
  try {
    for await (const _chunk of adapter.stream({
      model: 'fixture-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    })) {
      // A contentless turn should not deliver anything.
    }
  } catch (error) {
    escapedError = error;
  } finally {
    await adapter.close();
  }
  assert.equal(codeOf(escapedError), 'EMPTY_RESPONSE', `code was ${codeOf(escapedError)}`);
});

await check('the harness would actually retry that code', async () => {
  assert.equal(isRetryableCode('EMPTY_RESPONSE'), true);
  // The rest of the table, so the mapping cannot drift into retrying something deterministic.
  assert.equal(isRetryableCode(KIND_TO_CODE.soft_rate), true);
  assert.equal(isRetryableCode(KIND_TO_CODE.server), true);
  assert.equal(isRetryableCode(KIND_TO_CODE.cancelled), false);
  assert.equal(isRetryableCode(KIND_TO_CODE.hard_credit), false);
  assert.equal(isRetryableCode(KIND_TO_CODE.not_found), false);
  assert.equal(isRetryableCode(KIND_TO_CODE.client), false);
  assert.equal(isRetryableCode(codeFor(undefined)), false);
});

await check('the retryable set matches the harness default, name for name', async () => {
  // `dsh-llm-retry` matches against `retryableCodes`, which defaults to this list
  // (`@deepseek-ai/dsh-llm` → `DEFAULT_RETRYABLE_CODES`). The plugin's copy is a claim about the
  // harness, so it is written out here rather than read from the install: this test should fail if
  // either side changes, which is the point — a code the harness stopped retrying would otherwise
  // keep being produced and silently never retried again.
  const HARNESS_DEFAULT = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];

  const plugin = HARNESS_DEFAULT.filter((code) => isRetryableCode(code));
  assert.deepEqual(plugin, HARNESS_DEFAULT, 'the plugin treats a harness-retryable code as permanent');

  // And nothing outside that list may be retryable, or the plugin reports a retry that cannot happen.
  for (const code of Object.values(KIND_TO_CODE)) {
    if (HARNESS_DEFAULT.includes(code)) continue;
    assert.equal(isRetryableCode(code), false, `${code} is claimed retryable but the harness will not retry it`);
  }
});

// ── 5. A failure that is not one of ours keeps its own words ───────────────────────
await check('an unrecognised error is classified but not rewritten', async () => {
  const escapedError = await escaped(() => new Error('something nobody planned for'));
  assert.ok(isClassified(escapedError), 'an unexpected error reached the harness unclassified');
  assert.match(String(escapedError?.message), /something nobody planned for/u);
});

// ── 5b. End to end: a notice-shaped refusal the upstream sent as text ──────────────
await check('the Qoder allowance notice reaches the harness as QUOTA', async () => {
  // The live shape this was written for. Qoder refuses with a sentence, not a status code, so
  // nothing in the transport can classify it — the driver recognises it and marks the kind, and
  // the adapter turns that into a code. Before both halves existed the harness recorded it as
  // `dsh: INTERNAL: qoder: You've reached your daily usage limit …`, which is indistinguishable
  // from this plugin being broken.
  const file = join(scratch, `n-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify([
    "You've reached your daily usage limit for Chat. Come back tomorrow to continue working with me. Report Issue (input /feedback)"
  ]));
  process.env.FAKE_DELTAS_FILE = file;

  const adapter = new DriverAdapter({
    provider: 'qoder',
    displayName: 'Qoder',
    driver: {
      ownSystemPrompt: true,
      locate: async () => ({ installed: true, signedIn: true }),
      listModels: async () => [],
      openSession: async () =>
        new QoderConversation({
          runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
          cwd: process.cwd(),
          resolveCredential: async () => ({ token: 'x' }),
          logger: { debug() {}, info() {}, warn() {} }
        })
    },
    catalog: { models: async () => [] }
  });
  let escapedError;
  try {
    for await (const _chunk of adapter.stream({
      model: 'fake-model-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    })) {
      // The notice must not be delivered as an answer.
    }
  } catch (error) {
    escapedError = error;
  } finally {
    await adapter.close();
  }
  assert.equal(codeOf(escapedError), 'QUOTA', `code was ${codeOf(escapedError)}`);
  assert.equal(isRetryableCode(codeOf(escapedError)), false, 'an exhausted allowance must not be retried');
});

// ── 6. Nothing above may turn a healthy turn into a failure ────────────────────────
await check('a healthy turn still delivers its text', async () => {
  const adapter = new DriverAdapter({
    provider: 'fixture',
    displayName: 'Fixture',
    driver: {
      ownSystemPrompt: true,
      locate: async () => ({ installed: true, signedIn: true }),
      listModels: async () => [],
      openSession: async () => ({
        ready: true,
        close: async () => {},
        send: async function* () {
          yield { type: 'text-delta', text: 'The answer is 42.' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      })
    },
    catalog: { models: async () => [] }
  });
  const chunks = [];
  try {
    for await (const chunk of adapter.stream({
      model: 'fixture-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    })) {
      chunks.push(chunk);
    }
  } finally {
    await adapter.close();
  }
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'The answer is 42.');
  assert.equal(chunks.at(-1)?.type, 'finish');
});

rmSync(scratch, { recursive: true, force: true });

console.log(`\nfailure taxonomy: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
