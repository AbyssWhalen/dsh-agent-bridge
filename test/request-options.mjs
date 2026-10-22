/**
 * Three fields of the harness's request that never reached the wire.
 *
 * `GenerateOptions` carries eleven fields. The adapter consumed six — `model`,
 * `reasoningEffort`, `messages`, `system`, `tools`, `signal` — and dropped the rest without
 * saying so. Two of the dropped ones were measured arriving in a live session, by instrumenting
 * the adapter and running the real loop once:
 *
 *     OPTS purpose=undefined        maxTokens=128000 reasoningEffort="high"  model="deepseek-v4.1-flash" tools=24
 *     OPTS purpose="session-title"  maxTokens=64     reasoningEffort="high"  model="deepseek-v4.1-flash" tools=none
 *
 * So on every session, two requests arrive with a ceiling the driver never heard about:
 *
 * 1. **`maxTokens: 64` on the title turn.** The harness asks for a caption of at most 64 tokens
 *    and the driver sends no `max_tokens` at all, so the model is free to ramble a paragraph
 *    into a title slot — on a reasoning model, one that has already spent thinking tokens on it.
 * 2. **`purpose: "session-title"`.** The reference adapter turns exactly this into effort `off`:
 *
 *        const effort = options.purpose === "session-title" ? "off" : options.reasoningEffort ?? …
 *
 *    — `dsh-llm-deepseek`. Without it a one-line caption runs at the caller's full reasoning
 *    effort. Measured live: the title turn arrived with `reasoningEffort: "high"`.
 *
 * The third dropped field, `toolHistory`, is projected by the runtime before it reaches an
 * adapter that declares `toolUpdate`, so it is not this plugin's to handle and is not tested here.
 *
 * Nothing about this is visible as a failure: the answers are fine, the titles are fine, the
 * bills are slightly larger every session. That is why it survived 34 rounds of testing.
 */
import assert from 'node:assert/strict';
import { DriverAdapter } from '../lib/adapter.js';
import { WorkBuddyConversation } from '../drivers/workbuddy/conversation.js';

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

/**
 * Run one adapter turn and report what the driver was handed.
 *
 * @param {object} request - the `GenerateOptions` to send.
 * @returns {Promise<{seen: object, chunks: object[]}>}
 */
async function turn(request) {
  let seen;
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
        send: async function* (_messages, options) {
          seen = options;
          yield { type: 'text-delta', index: 0, text: 'ok' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      })
    },
    catalog: { models: async () => [] }
  });

  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'fixture-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    ...request
  })) {
    chunks.push(chunk);
  }
  await adapter.close();
  return { chunks, seen };
}

// ── 1. The ceiling must reach the driver ──────────────────────────────────────────
await check('maxTokens is handed to the driver', async () => {
  const { seen } = await turn({ maxTokens: 64 });
  assert.equal(seen?.maxTokens, 64, `the driver saw maxTokens ${JSON.stringify(seen?.maxTokens)}`);
});

await check('a turn with no ceiling does not invent one', async () => {
  const { seen } = await turn({});
  assert.equal(seen?.maxTokens, undefined, `the driver saw maxTokens ${JSON.stringify(seen?.maxTokens)}`);
});

// ── 2. A title turn must not be reasoned over ─────────────────────────────────────
await check('a session-title turn runs with reasoning off', async () => {
  const { seen } = await turn({ purpose: 'session-title', reasoningEffort: 'high', maxTokens: 64 });
  assert.equal(seen?.effort, 'off', `the driver saw effort ${JSON.stringify(seen?.effort)}`);
});

await check('an ordinary turn keeps the caller effort', async () => {
  const { seen } = await turn({ reasoningEffort: 'high' });
  assert.equal(seen?.effort, 'high', `the driver saw effort ${JSON.stringify(seen?.effort)}`);
});

await check('a title turn does not let its ceiling replace the caller effort rule', async () => {
  // Both fields arrive together on the title turn; honouring one must not drop the other.
  const { seen } = await turn({ purpose: 'session-title', reasoningEffort: 'high', maxTokens: 64 });
  assert.equal(seen?.maxTokens, 64, `the driver saw maxTokens ${JSON.stringify(seen?.maxTokens)}`);
  assert.equal(seen?.effort, 'off', `the driver saw effort ${JSON.stringify(seen?.effort)}`);
});

// ── 3. The WorkBuddy body must carry the ceiling ──────────────────────────────────
/**
 * Send one turn through the real driver and report the request body it built.
 *
 * @param {object} options - what the adapter would hand the driver.
 * @returns {Promise<object>} the JSON body handed to the upstream client.
 */
async function bodyFor(options) {
  let body;
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async (_credential, request) => {
        body = request;
        return {
          body: {
            async *[Symbol.asyncIterator]() {
              yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n');
              yield new TextEncoder().encode('data: [DONE]\n\n');
            }
          }
        };
      }
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });
  for await (const _chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'm', ...options })) {
    // Drain.
  }
  return body;
}

await check('the ceiling reaches the wire as max_tokens', async () => {
  const body = await bodyFor({ maxTokens: 64 });
  assert.equal(body?.max_tokens, 64, `body.max_tokens was ${JSON.stringify(body?.max_tokens)}`);
});

await check('an effort of off reaches the wire as none', async () => {
  // Measured: the upstream answers `reasoning_effort: "none"` with 0 reasoning tokens, while
  // omitting the field leaves thinking on. `off` is the harness's word, `none` is the wire's.
  const body = await bodyFor({ effort: 'off' });
  assert.equal(body?.reasoning_effort, 'none', `body.reasoning_effort was ${JSON.stringify(body?.reasoning_effort)}`);
});

await check('a real effort still reaches the wire unchanged', async () => {
  const body = await bodyFor({ effort: 'high' });
  assert.equal(body?.reasoning_effort, 'high', `body.reasoning_effort was ${JSON.stringify(body?.reasoning_effort)}`);
});

await check('a turn with neither field sends neither', async () => {
  const body = await bodyFor({});
  assert.equal('max_tokens' in body, false, `body.max_tokens was ${JSON.stringify(body.max_tokens)}`);
  assert.equal('reasoning_effort' in body, false, `body.reasoning_effort was ${JSON.stringify(body.reasoning_effort)}`);
});

await check('a nonsensical ceiling is not forwarded', async () => {
  const body = await bodyFor({ maxTokens: 0 });
  assert.equal('max_tokens' in body, false, `body.max_tokens was ${JSON.stringify(body.max_tokens)}`);
});

console.log(`\nrequest options: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
