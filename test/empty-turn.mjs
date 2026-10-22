/**
 * The empty turn, compared across both drivers.
 *
 * An empty turn is the hardest failure to notice, because nothing is wrong on the wire: no
 * error frame, no missing field, no timeout. The model produced no text, no reasoning and no
 * call, and the upstream reported success. Both drivers used to hand that to the harness as a
 * clean `finish`, which reads as a blank answer — the user gets no explanation and a credit
 * is gone.
 *
 * The Qoder driver already states the rule in a comment, for the *failed* case: an empty
 * reply "is indistinguishable from a refusal, which is the worst thing an empty answer can
 * be". The success case was not covered, on either driver. This suite exists so the two
 * cannot drift apart again — every case runs against both, and a fix applied to one side only
 * turns half the checks red.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-empty-'));

/**
 * One Qoder turn against the scripted runtime.
 *
 * @param {string[]} deltas
 * @param {{result?: string}} [extra]
 */
async function qoderTurn(deltas, extra = {}) {
  const file = join(scratch, `d-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(deltas));
  process.env.FAKE_DELTAS_FILE = file;
  delete process.env.FAKE_SPLIT;
  if (extra.result !== undefined) process.env.FAKE_RESULT = extra.result;
  else delete process.env.FAKE_RESULT;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1', effort: 'low' })) {
      chunks.push(chunk);
      if (chunk.type === 'error') failure = chunk.error?.message;
    }
  } catch (error) {
    failure = error.message;
  } finally {
    await conversation.close();
    delete process.env.FAKE_RESULT;
  }
  return { chunks, text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), failure };
}

/**
 * One WorkBuddy turn against a scripted SSE stream.
 *
 * @param {string[]} deltas
 */
async function workbuddyTurn(deltas) {
  const encoder = new TextEncoder();
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            for (const delta of deltas) {
              yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`);
            }
            yield encoder.encode('data: [DONE]\n\n');
          }
        }
      })
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      chunks.push(chunk);
      if (chunk.type === 'error') failure = chunk.error?.message;
    }
  } catch (error) {
    failure = error.message;
  }
  return { chunks, text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), failure };
}

// ── 1. Success on the wire, nothing in the answer ────────────────────────────────────
await check('qoder: a success frame with no content is not a clean finish', async () => {
  const { text, failure } = await qoderTurn([]);
  assert.equal(text, '');
  assert.notEqual(failure, undefined, 'the turn finished as `stop` with nothing in it and no explanation');
});

await check('workbuddy: a [DONE] with no content is not a clean finish', async () => {
  const { text, failure } = await workbuddyTurn([]);
  assert.equal(text, '');
  assert.notEqual(failure, undefined, 'the turn finished as `stop` with nothing in it and no explanation');
});

// ── 2. The rule must not swallow turns that did produce something ───────────────────
await check('qoder: a turn with text still finishes cleanly', async () => {
  const { text, failure } = await qoderTurn(['The answer is 42.']);
  assert.equal(text, 'The answer is 42.');
  assert.equal(failure, undefined, `a real answer was failed: ${failure}`);
});

await check('workbuddy: a turn with text still finishes cleanly', async () => {
  const { text, failure } = await workbuddyTurn(['The answer is 42.']);
  assert.equal(text, 'The answer is 42.');
  assert.equal(failure, undefined, `a real answer was failed: ${failure}`);
});

await check('qoder: a turn whose only output is a recovered call still finishes cleanly', async () => {
  // A call is output. Failing here would break every tool-only turn, which is the shape most
  // coding sessions actually have.
  const block = [
    '<｜｜DSML｜｜calls>',
    '<｜｜｜｜invoke name="pwsh">',
    '<｜｜｜｜parameter name="command">Get-Location</｜｜｜｜parameter>',
    '</｜｜｜｜invoke>',
    '</｜｜DSML｜calls>'
  ].join('\n');
  const { chunks, failure } = await qoderTurn([block]);
  assert.equal(failure, undefined, `a tool-only turn was failed: ${failure}`);
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
});

await check('workbuddy: a turn whose only output is a call still finishes cleanly', async () => {
  const encoder = new TextEncoder();
  const frame = {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'pwsh', arguments: '{"command":"Get-Location"}' } }]
      },
      index: 0
    }]
  };
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
            yield encoder.encode('data: [DONE]\n\n');
          }
        }
      })
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      chunks.push(chunk);
      if (chunk.type === 'error') failure = chunk.error?.message;
    }
  } catch (error) {
    failure = error.message;
  }
  assert.equal(failure, undefined, `a tool-only turn was failed: ${failure}`);
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
});

await new Promise((resolve) => setTimeout(resolve, 100));
rmSync(scratch, { recursive: true, force: true });

console.log(`\nempty turn parity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
