/**
 * A refresh triggered by spending has to reach the vendor.
 *
 * `Catalog.refreshQuota` runs immediately after a completed turn, because a turn is what spends
 * credit. Its whole purpose is to replace the figure the header shows with the post-turn one.
 *
 * A driver is allowed to memoize a balance — WorkBuddy holds one for 60 seconds, since billing is
 * a metered call on the user's own account. That memo silently defeated the refresh: the catalog
 * called `driver.quota()` with no arguments, got the cached pre-turn reading, and published it as
 * the new one. Every read-only check passed, because the reading was real; it was just the *old*
 * real reading. The user's report was exactly this — "the credits are not synchronised".
 *
 * These tests pin the two halves of the contract:
 *
 *   - a post-turn refresh asks for a fresh reading
 *   - the scheduled re-list may take a memoized one
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalog } from '../lib/catalog.js';

/**
 * A driver whose balance is memoized the way WorkBuddy's is.
 *
 * `reads` counts real vendor calls, so a test can tell "asked the vendor" from "answered from the
 * memo" — the distinction the defect hid behind.
 */
function memoizingDriver({ ttlMs = 60_000 } = {}) {
  const state = {
    reads: 0,
    freshAsked: 0,
    balance: { total: 100 },
    memo: undefined,
    at: 0,
    clock: 1_000
  };
  return {
    state,
    quota(options = {}) {
      if (options.fresh === true) state.freshAsked += 1;
      const stale = state.memo === undefined || state.clock - state.at >= ttlMs;
      if (options.fresh === true || stale) {
        state.reads += 1;
        state.memo = { ...state.balance };
        state.at = state.clock;
      }
      return state.memo;
    }
  };
}

function makeCatalog(driver) {
  return new Catalog({
    listModels: () => Promise.resolve([{ id: 'm1', name: 'M1' }]),
    normalize: (raw) => raw,
    quota: (fresh) => driver.quota({ fresh }),
    label: 'test',
    now: () => driver.state.clock
  });
}

test('a post-turn refresh asks the driver for a fresh reading', async () => {
  const driver = memoizingDriver();
  const catalog = makeCatalog(driver);

  // First load: the catalog reads the balance once.
  await catalog.refresh();
  assert.equal(driver.state.reads, 1, 'the first load did not read the balance');
  assert.equal(driver.state.freshAsked, 0, 'the scheduled re-list should not force a fresh read');

  // A turn spends credit. The vendor now reports a smaller figure, but the memo still holds the
  // old one — which is precisely the state a memoized driver is in right after a turn.
  driver.state.balance = { total: 40 };
  const before = catalog.quota();
  assert.equal(before.total, 100, 'fixture drifted: the memo should still hold the pre-spend figure');

  await catalog.refreshQuota();

  assert.equal(driver.state.freshAsked, 1, 'the post-turn refresh did not ask for a fresh reading');
  assert.equal(driver.state.reads, 2, 'the vendor was not called again');
  assert.deepEqual(catalog.quota(), { total: 40 }, 'the header kept the pre-spend figure');
});

test('without the fresh flag the refresh is defeated by the memo', async () => {
  // This is the defect itself, reproduced against a driver that memoizes. It has to fail to
  // refresh, or the test above is not measuring anything.
  const driver = memoizingDriver();
  const catalog = new Catalog({
    listModels: () => Promise.resolve([{ id: 'm1', name: 'M1' }]),
    normalize: (raw) => raw,
    // The old wiring: the flag is dropped on the floor.
    quota: () => driver.quota(),
    label: 'test',
    now: () => driver.state.clock
  });

  await catalog.refresh();
  driver.state.balance = { total: 40 };
  await catalog.refreshQuota();

  assert.equal(driver.state.freshAsked, 0);
  assert.deepEqual(catalog.quota(), { total: 100 }, 'this driver should have answered from its memo');
});

test('a failed refreshQuota leaves the published figure in place', async () => {
  const driver = memoizingDriver();
  const catalog = makeCatalog(driver);
  await catalog.refresh();
  assert.deepEqual(catalog.quota(), { total: 100 });

  // The vendor call now fails. The refresh must keep what it had rather than blank the header.
  const original = driver.quota;
  driver.quota = () => {
    throw new Error('billing endpoint returned 500');
  };
  await catalog.refreshQuota();
  assert.deepEqual(catalog.quota(), { total: 100 }, 'a failed refresh erased the balance');

  driver.quota = original;
});

test('overlapping refreshes share one vendor call', async () => {
  // The adapter fires the refresh without awaiting it, so several turns can overlap. Sharing the
  // in-flight pass is what keeps a burst of turns from becoming a burst of metered billing calls.
  const driver = memoizingDriver();
  const catalog = makeCatalog(driver);
  await catalog.refresh();
  const afterLoad = driver.state.reads;

  driver.state.balance = { total: 40 };
  await Promise.all([catalog.refreshQuota(), catalog.refreshQuota(), catalog.refreshQuota()]);

  assert.equal(driver.state.reads - afterLoad, 1, 'overlapping refreshes called the vendor more than once');
  assert.deepEqual(catalog.quota(), { total: 40 });
});

// ---- the seam between the driver and the catalog -------------------------------------------
//
// The tests above build a `Catalog` directly and hand it `(fresh) => driver.quota({ fresh })`. That
// proves the catalog asks for a fresh reading, but it does *not* prove the plugin's own wiring
// keeps the flag: `mount` used to call `() => driver.quota()` and drop it, and every test here
// would have passed anyway. So the wiring is exercised through the function `mount` uses.

test('the plugin wiring passes the freshness flag to the driver', async () => {
  const { quotaReader } = await import('../lib/index.js');
  const seen = [];
  const driver = {
    quota(options) {
      seen.push(options);
      return { total: 1 };
    }
  };

  const reader = quotaReader(driver);
  assert.equal(typeof reader, 'function', 'a driver with a balance must contribute a reader');

  reader(true);
  reader(false);
  reader();

  assert.equal(seen.length, 3, 'the reader did not call the driver every time');
  assert.equal(seen[0]?.fresh, true, 'a fresh request did not reach the driver');
  assert.equal(seen[1]?.fresh, false, 'a scheduled request should arrive as an explicit false');
  assert.equal(seen[2]?.fresh, undefined, 'an unqualified request should stay unqualified');
});

test('a vendor with no balance contributes no reader', async () => {
  const { quotaReader } = await import('../lib/index.js');
  assert.equal(quotaReader({}), undefined);
});
