/**
 * A turn whose caller is already gone must not be sent at all.
 *
 * Failing the case afterwards is not enough: the request still goes out, the account is still
 * charged, and the model still answers something nobody will read. The Qoder driver learned
 * this from a live capture — a cancelled turn spent the account's credit and left the child's
 * history one exchange longer than the class believed it to be.
 *
 * The WorkBuddy driver is stateless, so it has no history to corrupt, but it does have the
 * cost: `send()` reaches `chatStream` without looking at the signal first, so a turn cancelled
 * before it started is charged in full.
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

/**
 * Run one turn against a client that records whether it was called.
 *
 * @param {AbortSignal} signal
 * @returns {Promise<{requested: boolean, failure: string|undefined, kind: string|undefined}>}
 */
async function turnWithSignal(signal) {
  let requested = false;
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => {
        requested = true;
        const encoder = new TextEncoder();
        return {
          body: {
            async *[Symbol.asyncIterator]() {
              yield encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' }, index: 0 }] })}\n\n`
              );
              yield encoder.encode('data: [DONE]\n\n');
            }
          }
        };
      }
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  let failure;
  let kind;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model', signal })) {
      if (chunk.type === 'error') {
        failure = chunk.error?.message;
        kind = chunk.error?.kind;
      }
    }
  } catch (error) {
    failure = error.message;
    kind = error.kind;
  }
  return { requested, failure, kind };
}

// ── 1. Cancelled before the turn starts ────────────────────────────────────────────
await check('a turn cancelled before it starts never reaches the upstream', async () => {
  const controller = new AbortController();
  controller.abort();
  const { requested, failure } = await turnWithSignal(controller.signal);
  assert.equal(requested, false, 'the request went out anyway, so the account was charged for a turn nobody will read');
  assert.notEqual(failure, undefined, 'a cancelled turn reported success');
});

await check('that cancellation is reported as a cancellation, not an upstream fault', async () => {
  const controller = new AbortController();
  controller.abort();
  const { kind } = await turnWithSignal(controller.signal);
  assert.equal(kind, 'cancelled', `a cancellation was reported as ${JSON.stringify(kind)}`);
});

// ── 2. A signal that was never cancelled changes nothing ───────────────────────────
await check('a live signal still runs the turn', async () => {
  const controller = new AbortController();
  const { requested, failure } = await turnWithSignal(controller.signal);
  assert.equal(requested, true, 'a healthy turn did not reach the upstream');
  assert.equal(failure, undefined, `a healthy turn failed: ${failure}`);
});

console.log(`\npre-flight cancellation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
