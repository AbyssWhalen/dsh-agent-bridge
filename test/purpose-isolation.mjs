/**
 * A request the harness marks with a `purpose` must not enter the conversation.
 *
 * Measured from a live session, by instrumenting the pool key and running the real loop once:
 *
 *     KEY purpose=undefined        sessionId="session-10ff…" key=session-10ff… msgs=4
 *     KEY purpose="session-title"  sessionId="session-10ff…" key=session-10ff… msgs=1
 *     KEY purpose=undefined        sessionId="session-10ff…" key=session-10ff… msgs=6
 *
 * The title request carries **the same session id** as the user's conversation, so the pool
 * hands it the same conversation. For WorkBuddy that is harmless — every request carries its own
 * `messages` and nothing persists. For Qoder the pooled session *is* a live child process with
 * its own history, and the title prompt is appended to it:
 *
 *     user: <real turn 1>
 *     assistant: …
 *     user: Suggest one short title for a conversation about …
 *     assistant: "Sorting It Out"
 *     user: <real turn 2>
 *
 * The model now believes the user asked for a title in the middle of their conversation. Nothing
 * fails, nothing looks wrong, and the damage stays invisible until a reply references the stray
 * exchange. It is the same family as the cancelled-turn history leak this project already
 * recorded: *the child's history was one exchange longer than the class believed.*
 *
 * The harness distinguishes the two cases for us: `GenerateOptions.purpose` is
 * `'compaction' | 'session-title'`, and a request carrying one is not part of the dialogue.
 *
 * ## Why every test here drives one adapter through all three turns
 *
 * A first version built a fresh adapter per turn. The pool then never survived a turn, so every
 * request got its own child and the assertions passed while proving nothing — a title request
 * "ran in a session of its own" because *everything* did. Green from an unexercised path is the
 * failure mode this file exists to avoid, so the adapter is now created once and reused.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DriverAdapter } from '../lib/adapter.js';
import { QoderConversation } from '../drivers/qoder/conversation.js';

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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-purpose-'));
const runtime = fileURLToPath(new URL('./fake-measuring-runtime.mjs', import.meta.url));

/**
 * Read the fixture's JSONL log.
 *
 * @param {string} file
 * @returns {object[]}
 */
function entries(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * One adapter that keeps a live Qoder conversation pool, driven for a whole script.
 *
 * Both profile copies point at the same fixture, so a pool hit reuses one child process and a
 * pool miss spawns another — and the number of children is exactly what the log counts.
 */
function qoderAdapter() {
  return new DriverAdapter({
    provider: 'qoder',
    displayName: 'Qoder',
    driver: {
      ownSystemPrompt: true,
      locate: async () => ({ installed: true, signedIn: true }),
      listModels: async () => [],
      openSession: async () => {
        const conversation = new QoderConversation({
          runtimePath: runtime,
          cwd: process.cwd(),
          resolveCredential: async () => ({ token: 'x' }),
          logger: { debug() {}, info() {}, warn() {} }
        });
        return {
          send: (messages, options) => conversation.send(messages, options),
          close: () => conversation.close()
        };
      }
    },
    catalog: { models: async () => [] }
  });
}

/** One turn's request: an ordinary user turn, or a title request. */
const userTurn = (text) => ({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] });

/**
 * A conversation that grows the way a real one does.
 *
 * Identical messages on every turn would let the append branch match on content alone and hide
 * whether the pool did the right thing — the first draft of this file made exactly that mistake.
 */
const firstTurn = () => userTurn('first question');
const secondTurn = () => ({
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'second question' }] }
  ]
});

/**
 * Drive one turn through an existing adapter.
 *
 * @param {DriverAdapter} adapter
 * @param {object} request
 */
async function run(adapter, request) {
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'fake-model-1',
    sessionId: 'session-fixture',
    ...userTurn('go'),
    ...request
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Three turns: a real one, a title, then another real one — on one adapter. */
async function script(name) {
  const logFile = join(scratch, name);
  process.env.FAKE_MEASURE_LOG = logFile;
  process.env.FAKE_REPLY = 'ok';

  const adapter = qoderAdapter();
  try {
    await run(adapter, firstTurn());
    await run(adapter, { purpose: 'session-title', maxTokens: 64, ...userTurn('name this chat') });
    await run(adapter, secondTurn());
  } finally {
    await adapter.close();
  }
  return entries(logFile);
}

// ── 1. The title prompt must not land in the conversation's child ──────────────────
await check('a session-title request does not enter the conversation history', async () => {
  const log = await script('title.jsonl');
  const prompts = log.filter((entry) => entry.kind === 'prompt');
  assert.ok(prompts.length >= 3, `only ${prompts.length} prompts were sent`);
  // Turn 2 is the title request. Appended to the first child it is replayed onto a child that
  // already holds the user's conversation — which is the contamination this test is about.
  assert.equal(prompts[1].text.includes('name this chat'), true, 'the title prompt was not the second turn');
  assert.equal(prompts.at(-1).text.includes('second question'), true, 'the third turn was not the continuation');

  // The decisive fact is *order*, not the replay flag. A title prompt addressed to a child that
  // was started after it cannot have entered the conversation's child. Asserting `replay:false`
  // was the first version of this check, and it stayed green while the title was being appended
  // to the user's own child — the append branch does not mark itself as a replay.
  const order = log.map((entry) => entry.kind);
  const firstPrompt = order.indexOf('prompt');
  const secondFraming = order.indexOf('framing', firstPrompt);
  const titlePrompt = order.indexOf('prompt', firstPrompt + 1);
  assert.notEqual(secondFraming, -1, 'no second child was started at all');
  assert.ok(
    secondFraming < titlePrompt,
    `the title prompt went to the conversation's child (framing at ${secondFraming}, title prompt at ${titlePrompt})`
  );
});

// ── 2. It must be isolated deliberately, not by luck ──────────────────────────────
await check('a title request starts a child of its own', async () => {
  const log = await script('children.jsonl');
  const framings = log.filter((entry) => entry.kind === 'framing');
  // Two children: the conversation's, and a throwaway for the title. Three would mean the
  // conversation was thrown away too; one means the title went into it.
  assert.equal(framings.length, 2, `${framings.length} children were started, expected 2`);
});

// ── 3. The conversation must continue afterwards ──────────────────────────────────
await check('the conversation continues on its own child after a title request', async () => {
  const log = await script('cont.jsonl');
  const prompts = log.filter((entry) => entry.kind === 'prompt');
  const last = prompts.at(-1);
  assert.equal(last.replay, false, 'the conversation was rebuilt instead of continued');
});

// ── 3b. Compaction is the other purpose, and the same rule has to hold ────────────
await check('a compaction request does not enter the conversation history', async () => {
  const logFile = join(scratch, 'compact.jsonl');
  process.env.FAKE_MEASURE_LOG = logFile;
  process.env.FAKE_REPLY = 'summary';
  const adapter = qoderAdapter();
  try {
    await run(adapter, firstTurn());
    // Compaction is handed the whole history and asked to summarise it. Into a child that
    // already holds that history it would append a duplicate of the entire conversation.
    await run(adapter, { purpose: 'compaction', ...secondTurn() });
    await run(adapter, secondTurn());
  } finally {
    await adapter.close();
  }
  const log = entries(logFile);
  const order = log.map((entry) => entry.kind);
  const firstPrompt = order.indexOf('prompt');
  const secondFraming = order.indexOf('framing', firstPrompt);
  const compactionPrompt = order.indexOf('prompt', firstPrompt + 1);
  assert.notEqual(secondFraming, -1, 'compaction reused the conversation child');
  assert.ok(
    secondFraming < compactionPrompt,
    `the compaction prompt went to the conversation's child (framing ${secondFraming}, prompt ${compactionPrompt})`
  );
  const last = log.filter((entry) => entry.kind === 'prompt').at(-1);
  assert.equal(last.replay, false, 'the conversation was rebuilt after compaction');
});

// ── 4. Nothing else about an ordinary turn may change ─────────────────────────────
await check('an ordinary turn still reuses the pooled child', async () => {
  const logFile = join(scratch, 'plain.jsonl');
  process.env.FAKE_MEASURE_LOG = logFile;
  process.env.FAKE_REPLY = 'ok';
  const adapter = qoderAdapter();
  try {
    await run(adapter, firstTurn());
    await run(adapter, secondTurn());
  } finally {
    await adapter.close();
  }
  const log = entries(logFile);
  const framings = log.filter((entry) => entry.kind === 'framing');
  assert.equal(framings.length, 1, `${framings.length} children were started for two ordinary turns`);
  const prompts = log.filter((entry) => entry.kind === 'prompt');
  assert.equal(prompts.at(-1)?.replay, false, 'the second ordinary turn replayed instead of appending');
});

// ── 5. A stateless driver must be unaffected ──────────────────────────────────────
await check('a title request through the stateless driver still answers', async () => {
  let seen;
  const adapter = new DriverAdapter({
    provider: 'workbuddy',
    displayName: 'WorkBuddy',
    driver: {
      ownSystemPrompt: true,
      locate: async () => ({ installed: true, signedIn: true }),
      listModels: async () => [],
      openSession: async () => ({
        ready: true,
        close: async () => {},
        send: async function* (messages) {
          seen = messages;
          yield { type: 'text-delta', index: 0, text: 'ok' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      })
    },
    catalog: { models: async () => [] }
  });
  const chunks = [];
  for await (const chunk of adapter.stream({
    model: 'm',
    sessionId: 'session-fixture',
    purpose: 'session-title',
    ...userTurn('name this chat')
  })) {
    chunks.push(chunk);
  }
  await adapter.close();
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text, 'ok', `text was ${JSON.stringify(text)}`);
  assert.ok(Array.isArray(seen), 'the driver received no messages at all');
});

delete process.env.FAKE_MEASURE_LOG;
await new Promise((resolve) => setTimeout(resolve, 100));
rmSync(scratch, { recursive: true, force: true });

console.log(`\npurpose isolation: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
