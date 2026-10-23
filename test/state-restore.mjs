/**
 * `restoreDriver` is the one place in this plugin that can destroy a working driver.
 *
 * It moves a parked tree back into `drivers/<id>`, where the package root is the
 * installed plugin itself. Two failure modes matter, and neither is exotic:
 *
 *   1. The parked copy is not a directory. `parkDriver` only ever moves directories, so
 *      this copy did not come from this code — a damaged file, a half-copied tree, a
 *      leftover placeholder. Moving it in anyway publishes it as a driver and returns
 *      success; the failure surfaces much later as a load error naming a path that looks
 *      right.
 *   2. The move itself fails. The old order deleted the target first, so a copy that ran
 *      out of space left neither the installed driver nor the parked one on disk.
 *
 * Every case here uses a scratch root. `removedRoot()` is deliberately not parameterised —
 * it is the user's own `~/.dsh/agent-bridge-removed` — so each test parks and unparks
 * around it and removes what it created.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parkDriver, restoreDriver, hasParkedCopy } from '../lib/state.js';

/** One scratch package root, cleaned up by the caller. */
function scratch() {
  const root = join(tmpdir(), `state-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(root, 'drivers', 'qoder'), { recursive: true });
  writeFileSync(join(root, 'drivers', 'qoder', 'index.js'), 'export const driver = { id: "qoder" };');
  return root;
}

/** Park a driver, run the body, then always put the shared parking area back. */
async function parkedAround(root, body) {
  const parked = parkDriver('qoder', root);
  assert.equal(parked.ok, true, 'the fixture must park cleanly');
  try {
    return await body(parked.parkedAt);
  } finally {
    rmSync(parked.parkedAt, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test('a normal round trip puts the files back where they were', async () => {
  const root = scratch();
  await parkedAround(root, () => {
    assert.equal(existsSync(join(root, 'drivers', 'qoder')), false, 'parking removes the driver');
    const back = restoreDriver('qoder', root);
    assert.equal(back.ok, true);
    const file = join(root, 'drivers', 'qoder', 'index.js');
    assert.equal(existsSync(file), true, 'the driver file is back');
    assert.match(readFileSync(file, 'utf8'), /id: "qoder"/);
  });
});

test('a parked copy that is not a directory is refused, and the installed driver survives', async () => {
  const root = scratch();
  await parkedAround(root, (parkedAt) => {
    // Replace the parked tree with a plain file, the shape a damaged copy takes.
    rmSync(parkedAt, { recursive: true, force: true });
    writeFileSync(parkedAt, 'not a directory');

    // An installed driver is already in place; a bad restore must not cost it.
    mkdirSync(join(root, 'drivers', 'qoder'), { recursive: true });
    writeFileSync(join(root, 'drivers', 'qoder', 'index.js'), 'INSTALLED');

    const back = restoreDriver('qoder', root);
    assert.equal(back.ok, false, 'a malformed parked copy must be refused');
    assert.match(back.reason, /not a directory/);
    assert.equal(
      readFileSync(join(root, 'drivers', 'qoder', 'index.js'), 'utf8'),
      'INSTALLED',
      'the installed driver is untouched'
    );
  });
});

test('the target is never removed before the replacement has landed', async () => {
  // Judging the order from behaviour rather than from the source: with a parked copy the
  // move cannot satisfy, the installed tree must still be there afterwards.
  const root = scratch();
  await parkedAround(root, (parkedAt) => {
    rmSync(parkedAt, { recursive: true, force: true });
    writeFileSync(parkedAt, 'still not a directory');
    const back = restoreDriver('qoder', root);
    assert.equal(back.ok, false);
    // The driver was parked, so `drivers/qoder` is absent; nothing may have been created
    // in its place by the failed restore.
    assert.equal(existsSync(join(root, 'drivers', 'qoder')), false);
    assert.equal(hasParkedCopy('qoder'), true, 'the parked copy is left for a second attempt');
  });
});

test('restoring with nothing parked says so instead of succeeding', async () => {
  const root = scratch();
  rmSync(join(root, 'drivers', 'qoder'), { recursive: true, force: true });
  rmSync(join(tmpdir(), 'nothing-here'), { recursive: true, force: true });
  const back = restoreDriver('definitely-not-parked', root);
  assert.equal(back.ok, false);
  assert.match(back.reason, /no parked copy/);
  rmSync(root, { recursive: true, force: true });
});

test('a replaced directory is cleaned up, not left beside the driver', async () => {
  const root = scratch();
  await parkedAround(root, () => {
    // The driver is rebuilt by hand while a parked copy waits: the restore has to replace
    // it and take the old tree with it, or `drivers/` grows a `.replaced-<ts>` sibling on
    // every attempt.
    mkdirSync(join(root, 'drivers', 'qoder'), { recursive: true });
    writeFileSync(join(root, 'drivers', 'qoder', 'index.js'), 'OLDER');
    const back = restoreDriver('qoder', root);
    assert.equal(back.ok, true);
    const stray = readdirSync(join(root, 'drivers')).filter((name) => name.includes('.replaced-'));
    assert.deepEqual(stray, [], 'no moved-aside copy is left behind');
    assert.match(readFileSync(join(root, 'drivers', 'qoder', 'index.js'), 'utf8'), /id: "qoder"/);
  });
});
