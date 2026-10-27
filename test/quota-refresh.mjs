/**
 * The balance-only refresh.
 *
 * A turn is what spends credit, so the display has to be able to re-read the balance
 * without re-listing the models. Before this existed the header kept the pre-turn figure
 * until the next timer tick — up to five minutes of showing a number the user had already
 * spent, which is what "the credits are not synced" looks like from the outside.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Catalog } from '../lib/catalog.js';

const noop = () => {};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Build a catalog whose model list and balance are separately scripted. */
function makeCatalog({ quota = { creditsLeft: 100 }, models = [{ id: 'm1', displayName: 'M1' }] } = {}) {
  const calls = { models: 0, quota: 0 };
  let announced = 0;
  const catalog = new Catalog({
    label: 'test',
    listModels: async () => {
      calls.models += 1;
      return models;
    },
    normalize: (raw) => raw,
    quota: async () => {
      calls.quota += 1;
      return typeof quota === 'function' ? quota() : quota;
    },
    onChange: () => {
      announced += 1;
    },
    logger: { debug: noop, info: noop, warn: noop }
  });
  return { catalog, calls, announced: () => announced, setQuota: (fn) => { quota = fn; } };
}

test('the balance can be re-read without touching the model list', async () => {
  let credits = 100;
  const { catalog, calls } = makeCatalog({ quota: () => ({ creditsLeft: credits }) });
  await catalog.refresh();
  const modelsAfterFull = calls.models;
  assert.equal(modelsAfterFull, 1);

  credits = 80;
  const value = await catalog.refreshQuota();
  assert.equal(calls.models, modelsAfterFull, 're-listing the models is the round trip this avoids');
  assert.equal(calls.quota, 2, 'the balance was read again');
  assert.deepEqual(value, { creditsLeft: 80 });
  assert.deepEqual(catalog.quota(), { creditsLeft: 80 }, 'and the snapshot moved');
});

test('a changed balance announces once, an unchanged one does not', async () => {
  let credits = 100;
  const { catalog, announced } = makeCatalog({ quota: () => ({ creditsLeft: credits }) });
  await catalog.refresh();
  const afterFirst = announced();
  assert.ok(afterFirst >= 1, 'the first snapshot is announced');

  // Same reading: the picker must not re-render for nothing.
  await catalog.refreshQuota();
  assert.equal(announced(), afterFirst, 'an unchanged balance is not news');

  // Real change: the header has to update.
  credits = 42;
  await catalog.refreshQuota();
  assert.equal(announced(), afterFirst + 1, 'a spent balance is announced');
});

test('a failed balance read keeps the last good figure', async () => {
  let fail = false;
  const { catalog } = makeCatalog({
    quota: () => {
      if (fail) throw new Error('billing endpoint down');
      return { creditsLeft: 500 };
    }
  });
  await catalog.refresh();
  assert.deepEqual(catalog.quota(), { creditsLeft: 500 });

  fail = true;
  const value = await catalog.refreshQuota();
  // One bad poll must not look like a spent account.
  assert.deepEqual(value, { creditsLeft: 500 });
  assert.deepEqual(catalog.quota(), { creditsLeft: 500 });
});

test('a burst of turns shares one billing request', async () => {
  let resolveRead;
  let reads = 0;
  const catalog = new Catalog({
    label: 'slow',
    listModels: async () => [{ id: 'm1', displayName: 'M1' }],
    normalize: (raw) => raw,
    quota: () => {
      reads += 1;
      return new Promise((resolve) => {
        resolveRead = () => resolve({ creditsLeft: 10 });
      });
    },
    logger: { debug: noop, info: noop, warn: noop }
  });
  const first = catalog.refreshQuota();
  const second = catalog.refreshQuota();
  await tick();
  // Only one read should have been started, so there is exactly one resolver. Without the
  // single-flight guard the second call starts its own blocked read whose resolver
  // overwrote this variable, and awaiting it hangs the suite instead of failing it — so the
  // race below turns "the guard is gone" into an assertion failure rather than a stall.
  assert.equal(reads, 1, `expected one request, saw ${reads}`);
  resolveRead();
  const settled = await Promise.race([
    Promise.all([first, second]),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 2000))
  ]);
  assert.notEqual(settled, 'timed-out', 'both callers have to settle; the guard makes them share one read');
  assert.deepEqual(catalog.quota(), { creditsLeft: 10 }, 'the shared read is the one that landed');
});

test('a catalog with no balance reader reports nothing and does not throw', async () => {
  const catalog = new Catalog({
    label: 'bare',
    listModels: async () => [{ id: 'm1', displayName: 'M1' }],
    normalize: (raw) => raw,
    logger: { debug: noop, info: noop, warn: noop }
  });
  await catalog.refresh();
  assert.equal(await catalog.refreshQuota(), undefined);
  assert.equal(catalog.quota(), undefined);
});
