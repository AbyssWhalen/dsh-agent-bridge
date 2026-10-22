/**
 * A stream that goes silent is a transient failure, and the harness must be told so.
 *
 * The stall guard is correct in intent — an idle *timeout*, not an interval, so a slow but
 * healthy turn survives — but what it throws carried no kind at all:
 *
 *     queue.fail(new Error(`workbuddy: the stream produced nothing for ${STREAM_IDLE_TIMEOUT_MS}ms`));
 *
 * `kindOf()` finds nothing on a bare `Error`, so the failure reached the harness as `INTERNAL`,
 * and `INTERNAL` is not in `DEFAULT_RETRYABLE_CODES` (`EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`,
 * `TIMEOUT`, `TRANSPORT`). A connection that died mid-stream therefore ended the turn for good,
 * while a 429 one second later would have been retried.
 *
 * That is the exact failure mode `lib/failure.js` exists to prevent, reached through a path that
 * file never touched: the drivers' *own* throws, rather than the upstream failures they classify.
 *
 * The kind is `timeout`, mapped to the harness's own `TIMEOUT`. It is not `transport`: a
 * transport failure means no response arrived at all, while this one arrived and then stopped,
 * and the distinction is what the session log is for.
 *
 * ## Why this test does not take five minutes
 *
 * The guard's deadline is a module constant. Rather than fake timers — which would prove the
 * timer fires, not that the failure is classified — the conversation accepts an idle-timeout
 * override. Production never sets it; this test sets it to 40 ms.
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
 * A stream that yields a little, then goes silent forever.
 *
 * @param {number} idleTimeoutMs
 * @returns {Promise<{failure: object|undefined, text: string}>}
 */
async function stalledTurn(idleTimeoutMs) {
  const encoder = new TextEncoder();
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The first ' }, index: 0 }] })}\n\n`);
            // Then: silence. Not a close, not an error — the shape a dropped connection has.
            // A ref'd timer rather than a never-resolving promise: a bare pending promise leaves
            // the event loop with nothing to do, so node exits on an unsettled await instead of
            // letting the stall guard fire. A real stream holds a socket open and does keep the
            // loop alive.
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          }
        }
      })
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} },
    idleTimeoutMs
  });

  // The driver's contract is to *throw* a classified failure, so the caller's loop ends by
  // exception — and whatever the queue already held is delivered before that, which is what the
  // text assertion below is checking.
  const chunks = [];
  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      chunks.push(chunk);
    }
  } catch (error) {
    failure = error;
  }
  return {
    failure,
    text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  };
}

// ── 1. The stall must be classified, not merely reported ──────────────────────────
await check('a stalled stream fails with a kind the harness can act on', async () => {
  const { failure } = await stalledTurn(40);
  assert.notEqual(failure, undefined, 'the turn hung instead of failing');
  const kind = failure?.kind ?? failure?.bridgeKind;
  assert.notEqual(kind, undefined, `the stall carried no kind: ${JSON.stringify(failure?.message)}`);
});

await check('a stalled stream is reported as a timeout, not as an internal error', async () => {
  const { failure } = await stalledTurn(40);
  // Either field is legitimate — the drivers' own throws use `bridgeKind`, `UpstreamFailure`
  // uses `kind` — and `kindOf()` is the thing that reads both. Asserting only one of them would
  // fail on a correct implementation that happened to pick the other.
  const kind = failure?.kind ?? failure?.bridgeKind;
  assert.equal(kind, 'timeout', `kind was ${JSON.stringify(kind)}`);
});

await check('the harness would retry a stalled stream', async () => {
  // End to end: through the adapter, the way the harness actually receives it.
  const { code, retryable } = await escaped(40);
  assert.equal(code, 'TIMEOUT', `the harness saw ${code}`);
  assert.equal(retryable, true, `${code} is not retryable, so a dead connection would end the turn`);
});

/** Drive the adapter and report the code the harness would see. */
async function escaped(idleTimeoutMs) {
  const { LlmError } = await import('@deepseek-ai/dsh-llm').catch(() => ({}));
  const { isRetryableCode } = await import('../lib/failure.js');
  const adapter = new DriverAdapter({
    provider: 'fixture',
    displayName: 'Fixture',
    driver: {
      ownSystemPrompt: true,
      locate: async () => ({ installed: true, signedIn: true }),
      listModels: async () => [],
      openSession: async () => {
        const encoder = new TextEncoder();
        const conversation = new WorkBuddyConversation({
          client: {
            region: 'cn',
            chatStream: async () => ({
              body: {
                async *[Symbol.asyncIterator]() {
                  yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, index: 0 }] })}\n\n`);
                  await new Promise((resolve) => setTimeout(resolve, 3_000));
                }
              }
            })
          },
          resolveCredential: async () => ({ token: 'x' }),
          logger: { debug() {}, warn() {} },
          idleTimeoutMs
        });
        return { send: (messages, options) => conversation.send(messages, options), close: () => conversation.close() };
      }
    },
    catalog: { models: async () => [] }
  });
  try {
    for await (const _chunk of adapter.stream({
      model: 'fixture-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    })) {
      // Drain.
    }
  } catch (error) {
    const code = LlmError !== undefined && error instanceof LlmError ? error.failure.code : error.code ?? 'UNKNOWN';
    await adapter.close();
    return { code, retryable: isRetryableCode(code) };
  }
  await adapter.close();
  throw new Error('the stalled turn neither failed nor finished');
}

// ── 2. What arrived before the stall is still delivered ───────────────────────────
await check('the text that arrived before the stall is not thrown away', async () => {
  const { text } = await stalledTurn(40);
  assert.equal(text, 'The first ', `text was ${JSON.stringify(text)}`);
});

// ── 3. A healthy turn must not be touched by the override ────────────────────────
await check('a turn that keeps producing frames is not killed by the idle guard', async () => {
  const encoder = new TextEncoder();
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            // Six pieces, each 15 ms apart: slower than the 40 ms deadline in total, but never
            // idle for it. An interval-based guard would kill this; the deadline-based one must not.
            for (const piece of ['a', 'b', 'c', 'd', 'e', 'f']) {
              await new Promise((resolve) => setTimeout(resolve, 15));
              yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, index: 0 }] })}\n\n`);
            }
            yield encoder.encode('data: [DONE]\n\n');
          }
        }
      })
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} },
    idleTimeoutMs: 40
  });
  const chunks = [];
  for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
    chunks.push(chunk);
  }
  const failure = chunks.find((c) => c.type === 'error')?.error;
  assert.equal(failure, undefined, `a slow but live turn was failed: ${failure?.message}`);
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'abcdef');
});

console.log(`\nstall classification: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
