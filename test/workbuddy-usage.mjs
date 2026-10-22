/**
 * Token accounting for the WorkBuddy transport.
 *
 * The upstream's usage object is richer than what this driver reads, verified against a live
 * turn rather than guessed from the dialect:
 *
 *     {"prompt_tokens":28,"completion_tokens":21,"total_tokens":49,
 *      "completion_tokens_details":{"reasoning_tokens":18,"cached_tokens":0},
 *      "prompt_tokens_details":{"cached_tokens":0},
 *      "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":28,
 *      "cache_read_input_tokens":0,"cache_creation_input_tokens":0,
 *      "prompt_cache_write_tokens":0,"cached_tokens":0}
 *
 * Two things follow, and both were wrong:
 *
 * 1. **Cached prompt tokens were dropped.** The harness reads `inputTokens` as *uncached* input
 *    (`dsh-token-meter`: `uncachedInputTokens: usage.inputTokens`) and adds
 *    `cacheReadTokens + cacheWriteTokens` itself to get the pressure total. The OpenAI
 *    convention is that `prompt_tokens` **includes** the cached ones, so passing it through
 *    unchanged overstates uncached input by the cached amount and reports a cache-hit rate of
 *    zero on every turn — the one number a user can use to tell whether their prefix is being
 *    reused.
 * 2. **Nothing else about the shape was read.** `prompt_cache_hit_tokens` is the same fact under
 *    a second name, and `prompt_cache_write_tokens` is the cost of establishing the cache. Both
 *    were ignored.
 *
 * The totals are unaffected — cached input is still counted once, just in the wrong bucket — so
 * this is exactly the kind of defect that never shows up as a failure and never goes away.
 */
import assert from 'node:assert/strict';
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

const encoder = new TextEncoder();

/**
 * Run one turn whose final frame carries a given usage object.
 *
 * @param {object|undefined} usage
 * @returns {Promise<{usage: object|undefined, text: string}>}
 */
async function turnWith(usage) {
  const frames = [{ choices: [{ delta: { content: 'ok' }, index: 0 }] }];
  if (usage !== undefined) frames.push({ choices: [], usage });

  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            for (const frame of frames) yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
            yield encoder.encode('data: [DONE]\n\n');
          }
        }
      })
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  const chunks = [];
  for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
    chunks.push(chunk);
  }
  return {
    usage: chunks.find((c) => c.type === 'usage')?.usage,
    text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  };
}

// ── 1. Cached prompt tokens must land in their own bucket ──────────────────────────
await check('cached prompt tokens are reported as cache reads, not as fresh input', async () => {
  const { usage } = await turnWith({
    prompt_tokens: 10_000,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 9_000 }
  });
  assert.notEqual(usage, undefined, 'no usage was reported at all');
  assert.equal(usage.cacheReadTokens, 9_000, `cacheReadTokens was ${JSON.stringify(usage.cacheReadTokens)}`);
  // The harness treats `inputTokens` as uncached input and adds the cache buckets itself, so
  // passing `prompt_tokens` through here would count 9,000 cached tokens as fresh ones.
  assert.equal(usage.inputTokens, 1_000, `inputTokens was ${JSON.stringify(usage.inputTokens)}`);
});

await check('the total is not double counted', async () => {
  const { usage } = await turnWith({
    prompt_tokens: 10_000,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 9_000 }
  });
  // pressure = inputTokens + cacheReadTokens + cacheWriteTokens, per dsh-token-meter.
  const pressure = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  assert.equal(pressure, 10_000, `pressure was ${pressure}`);
});

await check('a cache write is reported too', async () => {
  const { usage } = await turnWith({
    prompt_tokens: 500,
    completion_tokens: 10,
    prompt_cache_write_tokens: 500
  });
  assert.equal(usage.cacheWriteTokens, 500, `cacheWriteTokens was ${JSON.stringify(usage.cacheWriteTokens)}`);
});

// ── 2. The second spelling of the same fact ────────────────────────────────────────
await check('prompt_cache_hit_tokens is understood as the cached count', async () => {
  const { usage } = await turnWith({
    prompt_tokens: 800,
    completion_tokens: 10,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 200
  });
  assert.equal(usage.cacheReadTokens, 600, `cacheReadTokens was ${JSON.stringify(usage.cacheReadTokens)}`);
  assert.equal(usage.inputTokens, 200, `inputTokens was ${JSON.stringify(usage.inputTokens)}`);
});

await check('cache_read_input_tokens is understood as well', async () => {
  const { usage } = await turnWith({
    prompt_tokens: 800,
    completion_tokens: 10,
    cache_read_input_tokens: 300
  });
  assert.equal(usage.cacheReadTokens, 300, `cacheReadTokens was ${JSON.stringify(usage.cacheReadTokens)}`);
  assert.equal(usage.inputTokens, 500, `inputTokens was ${JSON.stringify(usage.inputTokens)}`);
});

// ── 3. Nothing above may break an upstream that reports no cache at all ────────────
await check('a usage object with no cache fields still reports its input and output', async () => {
  const { usage } = await turnWith({ prompt_tokens: 28, completion_tokens: 21 });
  assert.equal(usage.inputTokens, 28);
  assert.equal(usage.outputTokens, 21);
  assert.equal(usage.cacheReadTokens, undefined, 'a cache bucket was invented where the upstream reported none');
});

await check('a turn with no usage frame at all still finishes with its text', async () => {
  const { usage, text } = await turnWith(undefined);
  assert.equal(usage, undefined);
  assert.equal(text, 'ok', `text was ${JSON.stringify(text)}`);
});

await check('a nonsensical cached count is ignored rather than subtracted', async () => {
  // More cached tokens than prompt tokens cannot happen; a driver that trusts it would report
  // negative input, which the harness's non-negative schema rejects outright.
  const { usage } = await turnWith({
    prompt_tokens: 100,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 5_000 }
  });
  assert.equal(usage.inputTokens, 100, `inputTokens was ${JSON.stringify(usage.inputTokens)}`);
  assert.equal(usage.cacheReadTokens, undefined, 'an impossible cache figure was reported');
});

console.log(`\nworkbuddy usage: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
