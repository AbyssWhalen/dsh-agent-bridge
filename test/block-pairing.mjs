/**
 * Block pairing when a turn dies mid-call.
 *
 * Every tool call the driver announces is two chunks: a `block-start` and a `block-end`. The
 * harness matches them, and the live history has already been broken once by an unpaired
 * announcement — that produced `11148 tool calls and tool results do not match`, which is why
 * this is worth checking rather than assuming.
 *
 * The case that matters is the one no happy path covers: the upstream starts a call, then the
 * connection dies. Only the WorkBuddy driver can be in that state. It opens a call on first
 * sight of a delta and closes it later, so a dying stream leaves one open. The Qoder driver
 * appends `block-start`, both argument deltas and `block-end` in one synchronous burst when a
 * call becomes known, so it has nothing to leave open — the check below asserts that property
 * rather than a fix.
 *
 * Runtime paths are resolved relative to this file, never to the working directory: this suite
 * also runs from the installed profile, where a bare `./` would silently point at nothing and
 * the resulting failure would read as a passing assertion.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-pair-'));

/** Every `block-start` needs a `block-end` with the same index. */
function unpaired(chunks) {
  const started = new Set();
  const ended = new Set();
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') started.add(chunk.index);
    if (chunk.type === 'block-end') ended.add(chunk.index);
  }
  return [...started].filter((index) => !ended.has(index));
}

const encoder = new TextEncoder();

/** A WorkBuddy stream that begins a tool call and then dies. */
async function workbuddyDiesMidCall() {
  const first = {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'pwsh', arguments: '{"comm' } }]
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
            yield encoder.encode(`data: ${JSON.stringify(first)}\n\n`);
            // The connection dies rather than the upstream sending an error frame. That is a
            // different code path: an error frame closes the calls explicitly, while a throw
            // lands in the catch and has to close them itself.
            throw new Error('socket hang up');
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
  return { chunks, failure };
}

/** A Qoder turn that recovers a call from a block whose closing tag never arrived. */
async function qoderRecoversCall() {
  const file = join(scratch, `d-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify([
    '<｜｜DSML｜｜calls>\n<｜｜｜｜invoke name="pwsh">\n<｜｜｜｜parameter name="command">Get-Location</｜｜｜｜parameter>'
  ]));
  process.env.FAKE_DELTAS_FILE = file;
  delete process.env.FAKE_SPLIT;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} }
  });

  const chunks = [];
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1', effort: 'low' })) {
      chunks.push(chunk);
    }
  } catch {
    // The turn's verdict is not what this check is about.
  } finally {
    await conversation.close();
  }
  return { chunks };
}

// ── 1. A call interrupted by a dying stream ────────────────────────────────────────
await check('workbuddy: a call cut off by a dying stream is still closed', async () => {
  const { chunks, failure } = await workbuddyDiesMidCall();
  assert.notEqual(failure, undefined, 'a broken stream reported success');
  assert.deepEqual(unpaired(chunks), [], `block indices left open: ${unpaired(chunks).join(', ')}`);
});

await check('qoder: a recovered call is announced and closed as a unit', async () => {
  const { chunks } = await qoderRecoversCall();
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.equal(calls.length, 1, `expected 1 recovered call, got ${calls.length}`);
  assert.deepEqual(unpaired(chunks), [], `block indices left open: ${unpaired(chunks).join(', ')}`);
});

// ── 2. The pairing rule must hold on the ordinary paths too ─────────────────────────
await check('workbuddy: a completed call is closed exactly once', async () => {
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
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      chunks.push(chunk);
    }
  } catch {
    // The turn's verdict is not what this check is about.
  }
  assert.deepEqual(unpaired(chunks), [], `block indices left open: ${unpaired(chunks).join(', ')}`);
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.equal(ends.length, 1, `expected exactly 1 tool-call block-end, got ${ends.length}`);
});

await new Promise((resolve) => setTimeout(resolve, 100));
rmSync(scratch, { recursive: true, force: true });

console.log(`\nblock pairing: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
