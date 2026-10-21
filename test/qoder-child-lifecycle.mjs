/**
 * What happens to a conversation when its worker child process dies.
 *
 * `QoderSession` is the lifetime of **one** child process, not a reconnecting client, and
 * three separate defects came out of treating it as if it were:
 *
 * 1. A child that exited *between* turns left `ready` true, so the next turn skipped
 *    `initialize`, wrote its prompt into a destroyed pipe where `#send()` dropped it
 *    silently, and then waited for a reply that could never arrive. Every turn after the
 *    crash hung indefinitely, delivering nothing and reporting nothing.
 * 2. A child that died *during* a turn was reported — but the session stayed "ready", so
 *    the turn after it hit the same dead pipe.
 * 3. A child that died while the host was answering a `fetch_job_token` request made both
 *    the success write and the error write fail. The second throw had no awaiter
 *    (`void this.#answerControl(...)`), and Node terminates the process on an unhandled
 *    rejection — so a child dying at the wrong moment took the whole DSH host with it.
 *
 * Each check here corresponds to one of those, and each was measured against a fake child
 * that dies on cue rather than inferred from reading the code.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';
import { QoderSession } from '../drivers/qoder/session.js';

const crashRuntime = fileURLToPath(new URL('./fake-crashing-runtime.mjs', import.meta.url));
const raceRuntime = fileURLToPath(new URL('./fake-control-race-runtime.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'));

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

/** Rethrow a message that names the defect, so a failure reads as something. */
async function turn(conversation, count, ceilingMs = 8000) {
  const messages = [
    { role: 'system', text: 'You are a coding agent.' },
    ...Array.from({ length: count }, (_, index) => ({ role: 'user', text: `question ${index + 1}` }))
  ];
  const chunks = [];
  let failure;
  const work = (async () => {
    try {
      for await (const chunk of conversation.send(messages, { model: 'fake-model-1', effort: 'low' })) chunks.push(chunk);
    } catch (error) {
      failure = error;
    }
  })();
  let timer;
  const ceiling = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ceilingMs);
  });
  const outcome = await Promise.race([work, ceiling]);
  clearTimeout(timer);
  return { outcome, failure, chunks };
}

/** The prompts the fake child recorded, one JSON object per delivered turn. */
function prompts(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function children(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

function child(name) {
  return new QoderConversation({
    runtimePath: crashRuntime,
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });
}

// ── 1. The child dies between turns ───────────────────────────────────────────────────
await check('the turn after a crash completes instead of hanging', async () => {
  const log = join(scratch, 'between.jsonl');
  const pids = join(scratch, 'between-pids.txt');
  process.env.CRASH_LOG = log;
  process.env.CRASH_PIDLOG = pids;
  process.env.CRASH_AFTER = '1';
  process.env.CRASH_MODE = 'between-turns';

  const conversation = child();
  try {
    const first = await turn(conversation, 1);
    assert.notEqual(first.outcome, 'timeout', 'the first turn hung on a live child');
    // The child exits on its own timer, off the end of the turn.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const second = await turn(conversation, 2);
    assert.notEqual(second.outcome, 'timeout', 'the turn after the crash hung — nothing upstream would ever time it out');
    assert.equal(second.failure, undefined, `the turn failed: ${second.failure?.message}`);
    assert.ok(second.chunks.length > 0, 'the turn reported success with no output at all');
  } finally {
    await conversation.close();
    delete process.env.CRASH_LOG;
    delete process.env.CRASH_PIDLOG;
  }
});

await check('the replacement child is a new process', async () => {
  const pids = children(join(scratch, 'between-pids.txt'));
  assert.ok(pids.length >= 2, `only ${pids.length} child process(es) were spawned; the dead one was reused`);
});

await check('the replacement is told the history it missed, not one lonely message', async () => {
  const sent = prompts(join(scratch, 'between.jsonl'));
  // The first prompt is the opening question. The second turn arrives at a **fresh** child,
  // so it must be a full replay — appending a single message to a child that has never seen
  // the conversation produces a prompt that reads as the user speaking out of nowhere.
  const replays = sent.filter((entry) => entry.replay);
  assert.ok(replays.length >= 1, `no replay reached the replacement child: ${JSON.stringify(sent.map((e) => e.bytes))}`);
});

// ── 2. The child dies mid-turn ──────────────────────────────────────────────────────
await check('a turn interrupted by a crash fails loudly', async () => {
  const log = join(scratch, 'mid.jsonl');
  const pids = join(scratch, 'mid-pids.txt');
  process.env.CRASH_LOG = log;
  process.env.CRASH_PIDLOG = pids;
  process.env.CRASH_AFTER = '1';
  process.env.CRASH_MODE = 'mid-turn';
  process.env.CRASH_DELAY_MS = '80';

  const conversation = child();
  try {
    const interrupted = await turn(conversation, 1);
    assert.notEqual(interrupted.outcome, 'timeout', 'the interrupted turn hung instead of failing');
    assert.ok(interrupted.failure !== undefined, 'the interrupted turn did not report an error');
    assert.match(String(interrupted.failure.message), /worker runtime exited/u, `the reason does not name the cause: ${interrupted.failure.message}`);

    // And the session is usable again afterwards, on a fresh child.
    const next = await turn(conversation, 2);
    assert.notEqual(next.outcome, 'timeout', 'the turn after an interrupted one hung');
  } finally {
    await conversation.close();
    delete process.env.CRASH_LOG;
    delete process.env.CRASH_PIDLOG;
    delete process.env.CRASH_DELAY_MS;
  }
});

// ── 3. Writing to a child that is already gone ──────────────────────────────────────
await check('a prompt written to a dead child is refused, not dropped in silence', async () => {
  // The guard this covers is `QoderSession#send()`, and it needs a session whose child is
  // dead but which nobody has told to close — a state a test cannot reach through
  // `QoderConversation`, because that replaces the child before it writes. So the fake is
  // asked to die on command, and the session is driven directly.
  process.env.CRASH_MODE = 'on-command';
  process.env.CRASH_DELAY_MS = '20';
  const session = new QoderSession({
    runtimePath: crashRuntime,
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });

  try {
    await session.initialize('You are a coding agent.');
    assert.equal(session.alive, true, 'the session was not alive right after initialize');

    await session.send('exit-now');
    // Wait for the exit event; `alive` is what the guard reads.
    for (let waited = 0; waited < 2000 && session.alive; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(session.alive, false, 'the session still reports a live child after the child exited');
    assert.equal(session.ready, false, '`ready` is what makes a caller skip initialize; it must not outlive the child');

    let threw;
    try {
      await session.send('are you there');
    } catch (error) {
      threw = error;
    }
    assert.ok(threw !== undefined, 'the prompt was accepted by a session with no child behind it');
    assert.match(String(threw.message), /worker runtime is gone/u, `the reason does not name the cause: ${threw.message}`);
  } finally {
    await session.close();
    delete process.env.CRASH_MODE;
    delete process.env.CRASH_DELAY_MS;
  }
});

// ── 4. The child dies while the host is answering it ────────────────────────────────
await check('a child dying during a control reply does not reject unhandled', async () => {
  // A stock Node process exits on an unhandled rejection, so the check installs a listener
  // that records instead of exiting. Anything recorded is a rejection that would have taken
  // the DSH host down with it.
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason instanceof Error ? reason.message : String(reason));
  process.on('unhandledRejection', onRejection);

  const conversation = new QoderConversation({
    runtimePath: raceRuntime,
    cwd: process.cwd(),
    // Slow on purpose: the race needs the child to die inside the window the token mint
    // opens. This stands in for the network the real path waits on.
    resolveCredential: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { token: 'x', expiresAt: new Date(Date.now() + 3600000).toISOString() };
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });

  try {
    const result = await turn(conversation, 1);
    assert.notEqual(result.outcome, 'timeout', 'the turn with a dying child hung');
    assert.ok(result.failure !== undefined, 'the turn reported success although the child died');
    // Give the failed write and any stray rejection time to surface.
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.deepEqual(rejections, [], `unhandled rejection(s): ${rejections.join(' | ')}`);
  } finally {
    await conversation.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.off('unhandledRejection', onRejection);
  }
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\nqoder child lifecycle: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

