/**
 * The WorkBuddy driver's leak handling, driven through a scripted stream.
 *
 * This exists because the two drivers were fixed asymmetrically. `isDegenerate()` was added
 * to the Qoder conversation and to nothing else, so a turn where the model repeats `｜`
 * until the budget runs out still renders a wall of bars on WorkBuddy: measured 500 bars of
 * text, no error, and 300 of them surviving beside ordinary prose.
 *
 * The Qoder side needs a child process; this one is stateless HTTP, so a client whose
 * `chatStream` yields scripted SSE frames is enough to drive the real translation path.
 *
 * Every case asserts on the *output* — what the harness would show a user — not on which
 * internal branch ran.
 */
import assert from 'node:assert/strict';
import { WorkBuddyConversation } from '../drivers/workbuddy/conversation.js';

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => Promise<void>} body
 */
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

/** A Response-shaped object whose body yields one SSE frame per delta. */
function scripted(deltas) {
  const encoder = new TextEncoder();
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        for (const delta of deltas) {
          yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`);
        }
        yield encoder.encode('data: [DONE]\n\n');
      }
    }
  };
}

/**
 * Run one turn and report what came out.
 *
 * @param {string[]} deltas
 * @returns {Promise<{text: string, calls: {name: string, arguments: string}[], failed: string|undefined, bars: number}>}
 */
async function turn(deltas) {
  const conversation = new WorkBuddyConversation({
    client: { region: 'cn', chatStream: async () => scripted(deltas) },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  const chunks = [];
  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      chunks.push(chunk);
      if (chunk.type === 'error') failure = chunk.error?.message ?? String(chunk.error);
    }
  } catch (error) {
    failure = error.message;
  }

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  const calls = chunks
    .filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
    .map((c) => ({ name: c.block.name, arguments: c.block.arguments }));
  return { text, calls, failed: failure, bars: (text.match(/[\uFF5C]/gu) ?? []).length };
}

// ── 1. The degenerate turn ───────────────────────────────────────────────────────────
await check('a runaway bar wall is not rendered as an answer', async () => {
  const { text, bars, failed } = await turn(['\uFF5C'.repeat(500)]);
  assert.equal(bars, 0, `${bars} bars reached the text channel: ${JSON.stringify(text.slice(0, 60))}`);
  assert.notEqual(failed, undefined, 'the turn reported nothing at all — a wall of bars and no explanation is the worst outcome');
});

await check('a runaway after ordinary prose does not keep the prose either', async () => {
  // Keeping "Here is the call: " and then nothing would read as a truncated answer. The turn
  // produced no answer, so it says so.
  const { text, bars, failed } = await turn(['Here is the call: ', '\uFF5C'.repeat(300)]);
  assert.equal(bars, 0, `${bars} bars reached the text channel`);
  assert.notEqual(failed, undefined, 'no explanation was reported');
  assert.ok(text.length < 40, `prose was kept beside a failed turn: ${JSON.stringify(text)}`);
});

// ── 2. Nothing else changes ──────────────────────────────────────────────────────────
await check('ordinary prose still renders', async () => {
  const { text, bars, failed } = await turn(['The answer is 42.']);
  assert.equal(text, 'The answer is 42.');
  assert.equal(bars, 0);
  assert.equal(failed, undefined);
});

// ── 3. An error after the answer arrived must not erase the answer ───────────────────
await check('an upstream error after an answer was delivered keeps the answer', async () => {
  // The Qoder driver learned this from a live capture: text streaming while an error banner
  // appears means the caller already read the answer and then the turn is declared dead. Its
  // rule is that a turn which delivered output is finished by its own result frame, and the
  // error is only logged. This driver failed the turn unconditionally, so the same upstream
  // behaviour threw away an answer the user had already seen.
  const frames = [
    { choices: [{ delta: { content: 'The answer is 42.' }, index: 0 }] },
    { error: { message: 'upstream hiccup' } }
  ];
  const encoder = new TextEncoder();
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            for (const frame of frames) yield encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
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

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text, 'The answer is 42.', `the delivered answer was lost: ${JSON.stringify(text)}`);
  assert.equal(failure, undefined, `an error was raised over an answer that had already arrived: ${failure}`);
  assert.ok(chunks.some((c) => c.type === 'finish'), 'the turn never finished');
});

await check('an upstream error before any output is still a failure', async () => {
  // The other half of the rule: with nothing delivered, the turn really did fail and saying so
  // is the only useful outcome.
  const encoder = new TextEncoder();
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            yield encoder.encode(`data: ${JSON.stringify({ error: { message: 'quota exhausted' } })}\n\n`);
          }
        }
      })
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      if (chunk.type === 'error') failure = chunk.error?.message;
    }
  } catch (error) {
    failure = error.message;
  }
  assert.notEqual(failure, undefined, 'a turn that produced nothing reported success');
  assert.match(failure, /quota exhausted/u, `the reason was lost: ${failure}`);
});

await check('a real call leak is still recovered, not rendered', async () => {
  const block = [
    '<｜｜DSML｜｜calls>',
    '<｜｜｜｜invoke name="pwsh">',
    '<｜｜｜｜parameter name="command">Get-Location</｜｜｜｜parameter>',
    '</｜｜｜｜invoke>',
    '</｜｜DSML｜calls>'
  ].join('\n');
  const { text, calls, bars } = await turn([block]);
  assert.equal(bars, 0, 'markup reached the text channel');
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.equal(calls[0].name, 'pwsh');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location' });
});

// ── 4. Cancellation reaches the turn the way the real transport reports it ──────────
await check('cancelling mid-stream reports a cancellation, keeping what was delivered', async () => {
  // `chatStream` hands the caller's signal to `fetch`, so a real cancellation reaches the
  // body iterator as a thrown `AbortError` rather than as silence. The driver's rule is that
  // one cancellation always looks like one thing: `UpstreamFailure('cancelled')`, not the raw
  // DOMException, so the host does not report a user's own stop as an upstream fault.
  const controller = new AbortController();
  const conversation = new WorkBuddyConversation({
    client: {
      region: 'cn',
      chatStream: async () => ({
        body: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'working' }, index: 0 }] })}\n\n`
            );
            // Then the connection dies the way an aborted fetch dies.
            await new Promise((resolve) => setTimeout(resolve, 30));
            const abort = new Error('The operation was aborted');
            abort.name = 'AbortError';
            throw abort;
          }
        }
      })
    },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });

  const cancellationTimer = setTimeout(() => controller.abort(), 10);
  const chunks = [];
  let failure;
  let cancellationKind;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], {
      model: 'fake-model',
      signal: controller.signal
    })) {
      chunks.push(chunk);
      if (chunk.type === 'error') {
        failure = chunk.error?.message;
        cancellationKind = chunk.error?.kind;
      }
    }
  } catch (error) {
    failure = error.message;
    cancellationKind = error.kind;
  } finally {
    clearTimeout(cancellationTimer);
  }

  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text, 'working', `text delivered before the cancel was lost: ${JSON.stringify(text)}`);
  assert.notEqual(failure, undefined, 'a cancelled turn reported success');
  assert.equal(cancellationKind, 'cancelled', `a cancellation was reported as ${JSON.stringify(cancellationKind)}: ${failure}`);
});

console.log(`\nworkbuddy dialect: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
