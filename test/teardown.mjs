/**
 * Offline verification of the teardown race that made a switched-off row come back.
 *
 * ## The bug this pins down
 *
 * Switching a component off unmounts it: the catalog timer stops, the provider
 * route is released, the sessions close. But a refresh that was *already* in
 * flight — a worker handshake, an HTTPS call — does not stop, and when it lands it
 * publishes and announces. The host's announce handler re-registers the provider
 * route, because that is how the account balance reaches the group header. So an
 * announce that arrives after the release puts the vendor back: the row the user
 * just switched off reappears in the picker, and `host.mjs` reports
 * `adapters remaining after cleanup: 1`.
 *
 * It was intermittent, which is the only reason it survived: cleanup usually wins
 * the race. `halt()` closes the window instead of narrowing it — the flag is set
 * before the route is released, so a late announce is impossible rather than
 * merely unlikely.
 *
 * This test forces the race instead of hoping for it: the driver's listing hangs
 * on a promise this file controls, teardown runs while it hangs, and only then is
 * the listing allowed to finish.
 *
 * Run with `node test/teardown.mjs`.
 */
import assert from 'node:assert/strict';
import { Catalog } from '../lib/catalog.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log('# teardown race');

/** A promise plus its two setters, for holding a refresh open on purpose. */
function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A catalog whose first listing hangs until the test releases it. */
function hangingCatalog() {
  const gate = deferred();
  const announced = [];
  const catalog = new Catalog({
    listModels: async () => {
      await gate.promise;
      return [{ id: 'm1' }];
    },
    normalize: (raw) => raw,
    label: 'test',
    onChange: () => announced.push(Date.now())
  });
  return { catalog, announced, release: () => gate.resolve() };
}

await check('a late refresh cannot announce after the mount was halted', async () => {
  const { catalog, announced, release } = hangingCatalog();
  const stop = catalog.start({ intervalMs: 10, retryMs: 10 });

  // Let the loop actually enter the hanging listing.
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Teardown order, exactly as `unmount()` runs it: silence, then stop, then the
  // route would be released. The release itself is not modelled here — the claim
  // under test is only that nothing is announced afterwards.
  catalog.halt();
  stop();

  release();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(announced.length, 0, `a halted catalog still announced ${announced.length} time(s)`);
});

await check('a catalog that was never halted announces normally', async () => {
  const gate = deferred();
  let announced = 0;
  const catalog = new Catalog({
    listModels: async () => {
      await gate.promise;
      return [{ id: 'm1' }];
    },
    normalize: (raw) => raw,
    label: 'test',
    onChange: () => {
      announced++;
    }
  });
  const stop = catalog.start({ intervalMs: 60_000, retryMs: 60_000 });
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 40));
  stop();
  assert.equal(announced, 1, 'the first publish did not announce');
  assert.equal(catalog.current().length, 1, 'the snapshot did not land');
});

await check('halting does not discard a snapshot that already landed', async () => {
  const catalog = new Catalog({
    listModels: async () => [{ id: 'm1' }],
    normalize: (raw) => raw,
    label: 'test',
    onChange: () => {}
  });
  const stop = catalog.start({ intervalMs: 60_000, retryMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  catalog.halt();
  stop();
  // Reads still work: the page may snapshot a component as it is being torn down,
  // and answering "no models" there would render a flash of an empty vendor.
  assert.equal(catalog.current().length, 1);
});

await check('a halted loop does not keep refreshing', async () => {
  let calls = 0;
  const catalog = new Catalog({
    listModels: async () => {
      calls++;
      return [{ id: 'm1' }];
    },
    normalize: (raw) => raw,
    label: 'test',
    onChange: () => {}
  });
  const stop = catalog.start({ intervalMs: 5, retryMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  catalog.halt();
  stop();
  const settled = calls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls, settled, `the loop kept running: ${settled} → ${calls}`);
});

console.log('');
if (failures > 0) {
  console.log(`# teardown: ${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('# teardown: OK');
}
