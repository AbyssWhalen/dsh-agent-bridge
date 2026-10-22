/**
 * A truncated turn is not a finished turn.
 *
 * The upstream says so explicitly, verified against a live request rather than assumed:
 *
 *     max_tokens: 20 → finish_reason values seen: ["length"]
 *
 * The driver never looked at that field. Two things followed, and the second is the dangerous
 * one:
 *
 * 1. **A cut-off answer was reported as complete.** The harness records `finish: stop` and the
 *    user reads a sentence that ends mid-word with no indication anything was withheld.
 * 2. **A cut-off tool call was kept and executed.** The driver closes every open call when the
 *    stream ends, so a call that was still arriving its arguments at the cut becomes a
 *    `block-end` with whatever JSON had landed. The harness has a rule for exactly this and it
 *    only fires on `max-tokens`:
 *
 *        const kept = this.finish.kind === "max-tokens"
 *          ? all.map((block) => block.type !== "tool-call")
 *          : void 0;
 *
 *    — `dsh-llm`, `AssistantStreamAccumulator`. Reported as `stop`, that rule never runs, so a
 *    half-written `{"command":"Get-Chil` reaches the tool as if the model had finished typing.
 *
 * `max-tokens` is the harness's own name for this outcome (`stop`, `tool-calls`, `max-tokens`
 * are the three the session format accepts), so the fix is to say what the upstream said.
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
 * Run one turn from a list of SSE frames.
 *
 * @param {object[]} frames
 * @returns {Promise<{finish: object|undefined, text: string, chunks: object[]}>}
 */
async function turn(frames) {
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
    finish: chunks.find((c) => c.type === 'finish')?.reason,
    chunks,
    text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  };
}

const text = (value) => ({ choices: [{ delta: { content: value }, index: 0 }] });
const stop = (reason) => ({ choices: [{ delta: {}, index: 0, finish_reason: reason }] });

// ── 1. The cut must be reported ────────────────────────────────────────────────────
await check('a truncated answer finishes as max-tokens, not as stop', async () => {
  const { finish } = await turn([text('The first three are 1, 2, 3 and the fo'), stop('length')]);
  assert.equal(finish?.kind, 'max-tokens', `finished as ${JSON.stringify(finish?.kind)}`);
});

await check('a complete answer still finishes as stop', async () => {
  const { finish } = await turn([text('Done.'), stop('stop')]);
  assert.equal(finish?.kind, 'stop', `finished as ${JSON.stringify(finish?.kind)}`);
});

await check('a turn whose upstream never names a reason still finishes as stop', async () => {
  // Not every stream sends `finish_reason`; a missing reason is not a truncation.
  const { finish } = await turn([text('Done.')]);
  assert.equal(finish?.kind, 'stop', `finished as ${JSON.stringify(finish?.kind)}`);
});

// ── 2. Truncation must win over "there were tool calls" ───────────────────────────
await check('a truncated turn that also made a call finishes as max-tokens', async () => {
  // `tool-calls` would tell the harness the call is complete and ready to run. It is not: the
  // upstream stopped mid-arguments, which is the case the harness drops tool blocks for.
  const partial = {
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'pwsh', arguments: '{"command":"Get-Chil' } }] },
      index: 0
    }]
  };
  const { finish } = await turn([partial, stop('length')]);
  assert.equal(finish?.kind, 'max-tokens', `finished as ${JSON.stringify(finish?.kind)}`);
});

// ── 3. The answer that did arrive is still delivered ──────────────────────────────
await check('the text that arrived before the cut is still delivered', async () => {
  const { text: out } = await turn([text('The first three are 1, 2, 3'), stop('length')]);
  assert.equal(out, 'The first three are 1, 2, 3', `text was ${JSON.stringify(out)}`);
});

// ── 4. A reason the upstream invents must not become an unknown finish ────────────
await check('an unrecognised finish reason does not produce a kind the harness rejects', async () => {
  const { finish } = await turn([text('Done.'), stop('content_filter')]);
  assert.ok(
    ['stop', 'tool-calls', 'max-tokens'].includes(finish?.kind),
    `finished as ${JSON.stringify(finish?.kind)}, which the session format does not accept`
  );
});

console.log(`\nworkbuddy truncation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
