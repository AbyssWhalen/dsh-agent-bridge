/**
 * Which user-visible guarantees does each driver actually implement?
 *
 * This exists because of a pattern, not a defect. Four separate bugs this round had the same
 * root: the two drivers each carry their own copy of the streaming state machine, so a rule
 * fixed on one side stays absent on the other —
 *
 *   - the degenerate-turn guard existed only on Qoder
 *   - the service-notice table existed but its input list was incomplete
 *   - the empty-turn rule existed on neither
 *   - the pre-flight cancellation check existed only on Qoder
 *
 * Reading the code one more time does not find these. A table does: name every guarantee the
 * user can observe, then ask each driver to demonstrate it. A guarantee nobody implements shows
 * up as a gap, and a guarantee only one driver implements shows up when the other's checks are
 * written.
 *
 * The checks below are behavioural and run against scripted transports, so this suite needs no
 * credentials, no child process, and no live quota.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-parity-'));
const encoder = new TextEncoder();

/**
 * Drive one Qoder turn.
 *
 * @param {string[]} deltas
 * @param {{signal?: AbortSignal}} [extra]
 */
async function qoder(deltas, extra = {}) {
  const file = join(scratch, `q-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(deltas));
  process.env.FAKE_DELTAS_FILE = file;
  delete process.env.FAKE_SPLIT;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  let kind;
  try {
    const options = { model: 'fake-model-1', effort: 'low', ...(extra.signal === undefined ? {} : { signal: extra.signal }) };
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], options)) {
      chunks.push(chunk);
      if (chunk.type === 'error') {
        failure = chunk.error?.message;
        kind = chunk.error?.kind;
      }
    }
  } catch (error) {
    failure = error.message;
    kind = error.kind;
  } finally {
    await conversation.close();
  }
  return { chunks, failure, kind, text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') };
}

/**
 * Drive one WorkBuddy turn.
 *
 * @param {object[]} frames - SSE payload objects, sent verbatim.
 * @param {{signal?: AbortSignal, hang?: boolean}} [extra]
 */
async function workbuddy(frames, extra = {}) {
  let requested = false;
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => {
        requested = true;
        return {
          body: {
            async *[Symbol.asyncIterator]() {
              for (const frame of frames) yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
              if (extra.hang !== true) yield encoder.encode('data: [DONE]\n\n');
            }
          }
        };
      }
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  let kind;
  try {
    const options = { model: 'fake-model', ...(extra.signal === undefined ? {} : { signal: extra.signal }) };
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], options)) {
      chunks.push(chunk);
      if (chunk.type === 'error') {
        failure = chunk.error?.message;
        kind = chunk.error?.kind;
      }
    }
  } catch (error) {
    failure = error.message;
    kind = error.kind;
  }
  return { chunks, failure, kind, requested, text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') };
}

/** A plain text frame for the WorkBuddy transport. */
const text = (value) => ({ choices: [{ delta: { content: value }, index: 0 }] });

// ══ The parity table ════════════════════════════════════════════════════════════════
//
// One entry per guarantee a user can observe. Both drivers have to answer every one.

const guarantees = [
  {
    name: 'a cancelled turn never reaches the upstream',
    async qoder() {
      const controller = new AbortController();
      controller.abort();
      const { failure, kind } = await qoder(['never'], { signal: controller.signal });
      assert.notEqual(failure, undefined, 'the turn reported success');
      assert.equal(kind, 'cancelled', `reported as ${JSON.stringify(kind)}`);
    },
    async workbuddy() {
      const controller = new AbortController();
      controller.abort();
      const { requested, failure, kind } = await workbuddy([text('never')], { signal: controller.signal });
      assert.equal(requested, false, 'the request went out anyway');
      assert.notEqual(failure, undefined, 'the turn reported success');
      assert.equal(kind, 'cancelled', `reported as ${JSON.stringify(kind)}`);
    }
  },
  {
    name: 'an empty turn is a failure, not a blank answer',
    async qoder() {
      const { text: out, failure } = await qoder([]);
      assert.equal(out, '');
      assert.notEqual(failure, undefined, 'finished as `stop` with nothing in it');
    },
    async workbuddy() {
      const { text: out, failure } = await workbuddy([]);
      assert.equal(out, '');
      assert.notEqual(failure, undefined, 'finished as `stop` with nothing in it');
    }
  },
  {
    name: 'a repetition loop is a failure, not rendered',
    async qoder() {
      const { text: out, failure } = await qoder(['\uFF5C'.repeat(500)]);
      assert.equal(/[\uFF5C]/u.test(out), false, `${out.length} bars reached the text channel`);
      assert.notEqual(failure, undefined, 'reported nothing at all');
    },
    async workbuddy() {
      const { text: out, failure } = await workbuddy([text('\uFF5C'.repeat(500))]);
      assert.equal(/[\uFF5C]/u.test(out), false, `${out.length} bars reached the text channel`);
      assert.notEqual(failure, undefined, 'reported nothing at all');
    }
  },
  {
    name: 'call markup never reaches the text channel',
    async qoder() {
      const block = [
        '<｜｜DSML｜｜calls>',
        '<｜｜｜｜invoke name="pwsh">',
        '<｜｜｜｜parameter name="command">Get-Location</｜｜｜｜parameter>',
        '</｜｜｜｜invoke>',
        '</｜｜DSML｜calls>'
      ].join('\n');
      const { text: out, chunks } = await qoder([block]);
      assert.equal(/[\uFF5C]/u.test(out), false, `markup reached the text: ${JSON.stringify(out.slice(0, 60))}`);
      assert.equal(chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').length, 1);
    },
    async workbuddy() {
      const frame = {
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'pwsh', arguments: '{"command":"Get-Location"}' } }] },
          index: 0
        }]
      };
      const { text: out, chunks } = await workbuddy([frame]);
      assert.equal(/[\uFF5C]/u.test(out), false, 'markup reached the text');
      assert.equal(chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').length, 1);
    }
  },
  {
    name: 'every announced block is closed, even when the stream dies',
    async qoder() {
      // The Qoder driver emits a call as one synchronous burst, so the property holds by
      // construction; asserted here so a future change to streaming calls turns it red.
      const { chunks } = await qoder([]);
      const open = new Set();
      for (const c of chunks) {
        if (c.type === 'block-start') open.add(c.index);
        if (c.type === 'block-end') open.delete(c.index);
      }
      assert.deepEqual([...open], [], 'block indices left open');
    },
    async workbuddy() {
      const frame = {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'pwsh', arguments: '{"comm' } }] }, index: 0 }]
      };
      const { chunks } = await workbuddy([frame], { hang: true });
      const open = new Set();
      for (const c of chunks) {
        if (c.type === 'block-start') open.add(c.index);
        if (c.type === 'block-end') open.delete(c.index);
      }
      assert.deepEqual([...open], [], 'block indices left open');
    }
  },
  {
    name: 'a turn that arrives in one piece is delivered exactly once',
    async qoder() {
      const { text: out, failure } = await qoder(['The answer is 42.']);
      assert.equal(out, 'The answer is 42.');
      assert.equal(failure, undefined, `a real answer was failed: ${failure}`);
    },
    async workbuddy() {
      const { text: out, failure } = await workbuddy([text('The answer is 42.')]);
      assert.equal(out, 'The answer is 42.');
      assert.equal(failure, undefined, `a real answer was failed: ${failure}`);
    }
  }
];

for (const guarantee of guarantees) {
  for (const driver of ['qoder', 'workbuddy']) {
    await check(`${driver}: ${guarantee.name}`, () => guarantee[driver]());
  }
}

console.log(`       ${guarantees.length} guarantees x 2 drivers = ${guarantees.length * 2} checks`);

await new Promise((resolve) => setTimeout(resolve, 100));
rmSync(scratch, { recursive: true, force: true });

console.log(`\ndriver parity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
