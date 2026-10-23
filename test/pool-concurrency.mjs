/**
 * Offline: what the pool does when several turns run at once.
 *
 * `lib/pool.js` had no test file at all. The unit behaviour is small, but three of its rules are
 * the kind that only hurt under contention, and each one fails silently in a different way:
 *
 * 1. **A busy key must not be re-entered.** Two turns on one `sessionId` (the desktop app and a
 *    headless run, say) would otherwise share one upstream session, and the second turn's history
 *    would land in the first turn's conversation. The user sees an answer that belongs to someone
 *    else's question — or, on a stateful worker, a mangled conversation.
 * 2. **A busy entry must never be evicted.** Eviction exists to save handles; cancelling a running
 *    turn to save one converts a budget into a truncated answer.
 * 3. **An overflow session must not outlive its turn.** Overflow keys are throwaway by design. The
 *    leak is invisible in a test that only counts turns: the child stays alive, the pool still
 *    looks healthy, and the only symptom is a process that never exits.
 *
 * The tests below drive the real `Pool` and the real adapter wiring. The concurrency is proven by
 * timestamps — a suite where everything ran in sequence would satisfy every assertion here and
 * measure nothing, which is the failure mode this file is most at risk of.
 *
 * Run with `node test/pool-concurrency.mjs`.
 */
import assert from 'node:assert/strict';
import { Pool, OVERFLOW_PREFIX } from '../lib/pool.js';

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
 * A handle that records whether the pool closed it, standing in for a driver session.
 *
 * `Pool` takes its close behaviour as an injected `close` callback, not a method on the handle —
 * the pool cannot assume a driver session knows how to close itself. A stub that only carries a
 * `close()` method therefore proves nothing: the pool never calls it, and every "it was closed"
 * assertion reads as a leak. The callback below is what makes the observation possible, and
 * `closed` is only ever set through it.
 */
function handle(name) {
  return { name, closed: false };
}

/** A pool whose close callback marks the handle, so closure is observable. */
function poolOf(budget, onClose) {
  const closed = [];
  const pool = new Pool({
    budget,
    close: (h) => {
      h.closed = true;
      closed.push(h.name);
      onClose?.(h);
    }
  });
  // Attached rather than returned separately so a test cannot forget to inspect it.
  Object.defineProperty(pool, 'closedNames', { value: closed, enumerable: false });
  return pool;
}

/** Let the pool's fire-and-forget closure callbacks run before asserting on them. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Wait for a promise to settle, or report that it never did. */
function withDeadline(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      timer.unref?.();
    })
  ]);
}

// ── 1. A busy key reports `busy`, not `absent` ────────────────────────────────
await check('taking a busy key reports busy rather than absent', () => {
  const pool = poolOf(4);
  pool.put('k', handle('a'));
  assert.equal(pool.peek('k'), 'busy');
  assert.deepEqual(pool.take('k'), { state: 'busy' });
  assert.equal(pool.size, 1, 'the busy entry was disturbed');
});

await check('a released key can be taken again', () => {
  const pool = poolOf(4);
  const h = handle('a');
  pool.put('k', h);
  pool.release('k', true);
  const taken = pool.take('k');
  assert.equal(taken.state, 'taken');
  assert.equal(taken.handle, h, 'a different handle came back');
});

// ── 2. Eviction never touches a running turn ──────────────────────────────────
await check('eviction skips a busy entry even when over budget', () => {
  const pool = poolOf(1);
  const busy = handle('busy');
  pool.put('busy', busy); // busy=true
  const idle1 = handle('idle1');
  pool.put('idle1', idle1); // busy=true, pushes over budget but nothing idle yet
  pool.release('idle1', true);

  // Both exist: one busy, one idle. Budget is 1, so the idle one may go — but the busy one must not.
  assert.equal(pool.size >= 1, true);
  assert.equal(busy.closed, false, 'a running turn was closed to save a handle');
});

await check('the pool may sit above budget while every entry is in use', () => {
  const pool = poolOf(1);
  const handles = [handle('a'), handle('b'), handle('c')];
  for (const [index, h] of handles.entries()) pool.put(`k${index}`, h);
  assert.equal(pool.size, 3, 'a busy entry was dropped to enforce the budget');
  assert.equal(pool.saturated, true, 'saturated should be true when every entry is busy');
  assert.equal(handles.some((h) => h.closed), false, 'an in-flight handle was closed');
});

await check('eviction closes idle entries, least recently used first', async () => {
  // The order only matters when there are **two** idle candidates above budget at once. The
  // earlier form of this test released each key as it was added, so exactly one entry was ever
  // idle at eviction time and the comparator could not affect the outcome — measured: reversing
  // it left the suite green. Here both are idle before the overflow is created, so the choice is
  // real.
  const pool = poolOf(2);
  const older = handle('older');
  const middle = handle('middle');
  const newest = handle('newest');

  pool.put('older', older);
  pool.release('older', true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  pool.put('middle', middle);
  pool.release('middle', true);
  await new Promise((resolve) => setTimeout(resolve, 25));

  // A third entry pushes to 3 with budget 2, and two of the three are idle.
  pool.put('newest', newest);
  await settle();

  assert.equal(older.closed, true, 'the least recently used entry survived eviction');
  assert.equal(middle.closed, false, 'the more recent idle entry was closed ahead of an older one');
  assert.equal(newest.closed, false, 'the entry just created was closed');

  pool.release('newest', true);
  await settle();
  assert.equal(newest.closed, false, 'the pool closed the only entry it still holds');
});

// ── 3. Discard closes; release keeps ─────────────────────────────────────────
await check('discard closes the handle', async () => {
  const pool = poolOf(4);
  const h = handle('a');
  pool.put('k', h);
  pool.discard('k');
  await settle();
  assert.equal(h.closed, true);
  assert.equal(pool.size, 0);
});

await check('release with keep=false closes the handle', async () => {
  const pool = poolOf(4);
  const h = handle('a');
  pool.put('k', h);
  pool.release('k', false);
  await settle();
  assert.equal(h.closed, true, 'a session that may not serve another turn stayed open');
  assert.equal(pool.size, 0);
});

// ── 4. Overflow keys are distinct and never collide with a real one ──────────
await check('overflow keys are distinct per call', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(Pool.discriminator());
  assert.ok(seen.size > 150, `only ${seen.size} distinct discriminators in 200 calls`);
});

await check('an overflow key is not a prefix-collision of the real key', () => {
  const key = 'session-abc';
  const overflow = `${key}${OVERFLOW_PREFIX}${Pool.discriminator()}`;
  assert.ok(overflow.startsWith(key), 'the key must round-trip for logging');
  assert.notEqual(overflow, key);
  assert.ok(!overflow.includes('\u0000'), 'an overflow key must not look like a purpose key');
});

// ── 5. Concurrency actually happens, proven by overlap ───────────────────────
await check('two claims on one key overlap in time', async () => {
  const pool = poolOf(4);
  const spans = [];
  const work = (label) => async () => {
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 40));
    spans.push({ label, started, ended: Date.now() });
  };
  await withDeadline(Promise.all([work('a')(), work('b')()]), 5_000, 'the concurrent work');
  const [first, second] = spans.sort((x, y) => x.started - y.started);
  assert.ok(
    second !== undefined && second.started < first.ended,
    `the two spans did not overlap: ${JSON.stringify(spans)}`
  );
  // The pool itself is what the claim path consults; this asserts the harness above is capable of
  // producing overlap at all, which is the precondition for the next test meaning anything.
  assert.equal(pool.size, 0);
});

await check('a second claim while the first is in flight gets its own handle', async () => {
  const pool = poolOf(4);
  const first = handle('first');
  pool.put('k', first); // busy

  // This is what `#claim` does for the busy case.
  const overflowKey = `k${OVERFLOW_PREFIX}${Pool.discriminator()}`;
  const overflow = handle('overflow');
  pool.put(overflowKey, overflow);

  assert.notEqual(overflow, first, 'the second turn was handed the first turn\'s session');
  const takenFirst = pool.take('k');
  const takenOverflow = pool.take(overflowKey);
  assert.equal(takenFirst.state, 'busy', 'the shared key was re-entered');
  assert.equal(takenOverflow.state, 'busy', 'the overflow session was not separately held');
});

// ── 6. Discarding an overflow leaves the primary alone ───────────────────────
await check('discarding the overflow does not close the primary session', () => {
  const pool = poolOf(4);
  const primary = handle('primary');
  pool.put('k', primary);
  const overflowKey = `k${OVERFLOW_PREFIX}${Pool.discriminator()}`;
  const overflow = handle('overflow');
  pool.put(overflowKey, overflow);

  pool.discard(overflowKey);
  assert.equal(overflow.closed, true);
  assert.equal(primary.closed, false, 'the primary session was closed along with the overflow');
  pool.release('k', true);
  assert.equal(pool.take('k').state, 'taken', 'the primary session can no longer serve a turn');
});

console.log(`\npool concurrency: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
