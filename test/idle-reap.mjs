/**
 * Offline: the idle reaper closes the session, and the pool is not told.
 *
 * `drivers/qoder/session.js` arms a five-minute timer on every sign of life and closes itself when
 * it fires. The pool is never notified, so `Pool.peek` still reports the entry as `idle` and
 * `Pool.take` still hands it out. That is deliberate — the reaper exists because a Qoder worker
 * child is ~655 MB resident, and holding one open for every finished conversation is not an
 * option — but the gap between "the session closed itself" and "the pool still advertises it" is
 * what the adapter's next `take` has to cope with.
 *
 * Measured on `dfmodel`: a turn that spawns a worker takes 8306 ms; one that reuses takes 1139 ms.
 * So the reaper costs a ~7x cold start on the first turn after it fires. That is the trade, and it
 * is why the reap is now logged.
 *
 * `runtimePath` is injectable, so this runs against a stand-in worker and needs no Qoder install.
 * `idleTeardownMs` is injectable for the same reason `catalogTtlMs` is: a path nobody can reach in
 * a test is a path nothing checks.
 *
 * Run with `node test/idle-reap.mjs`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * A stand-in for the Qoder worker runtime.
 *
 * It stays alive, accepts stdin, and answers `interrupt` — the one control request these tests
 * make. Answering matters: `#request` waits up to 30 s for a reply, so a silent stand-in would
 * turn a 700 ms idle window into a 30 s hang and the reaper would fire while the test waited,
 * which reads as "activity did not reset the timer" rather than "the stub never answered".
 */
function fakeRuntime(dir) {
  const path = join(dir, 'worker.mjs');
  writeFileSync(
    path,
    [
      'process.stdin.setEncoding("utf8");',
      'let buffer = "";',
      'const reply = (id, payload) => process.stdout.write(JSON.stringify({ type: "response", request_id: id, response: payload }) + "\\n");',
      'process.stdin.on("data", (chunk) => {',
      '  buffer += chunk;',
      '  let at;',
      '  while ((at = buffer.indexOf("\\n")) !== -1) {',
      '    const line = buffer.slice(0, at).trim();',
      '    buffer = buffer.slice(at + 1);',
      '    if (line.length === 0) continue;',
      '    let msg;',
      '    try { msg = JSON.parse(line); } catch { continue; }',
      '    const id = msg.request_id ?? msg.id;',
      '    if (msg.subtype === "interrupt" || msg.type === "interrupt") reply(id, {});',
      '    else reply(id, {});',
      '  }',
      '});',
      'const stop = () => process.exit(0);',
      'process.on("SIGTERM", stop);',
      'process.on("SIGINT", stop);',
      'process.stdin.on("end", stop);',
      'setInterval(() => {}, 60_000);'
    ].join('\n'),
    'utf8'
  );
  return path;
}

/** Live worker children owned by this process. */
function liveChildren() {
  const kids = (process._getActiveHandles?.() ?? []).filter((h) => h?.constructor?.name === 'ChildProcess');
  return kids.filter((kid) => kid.signalCode === null && kid.exitCode === null).length;
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-idle-test-'));
const runtimePath = fakeRuntime(dir);

/** Build a session against the stand-in worker. */
async function makeSession(idleTeardownMs, logs) {
  const { QoderSession } = await import('../drivers/qoder/session.js');
  return new QoderSession({
    model: 'stub',
    cwd: dir,
    runtimePath,
    idleTeardownMs,
    logger: {
      debug: (line) => logs.push(line),
      info() {},
      warn() {},
      error() {}
    }
  });
}

// ── The reaper fires ────────────────────────────────────────────────────────
await check('an idle session closes itself when the reaper fires', async () => {
  const logs = [];
  const before = liveChildren();
  const session = await makeSession(300, logs);
  assert.equal(liveChildren(), before + 1, 'the stand-in worker did not start');
  assert.equal(session.alive, true, 'the session did not start alive');

  await new Promise((resolve) => setTimeout(resolve, 900));

  assert.equal(session.alive, false, 'the session was still alive past its idle threshold');
  assert.equal(liveChildren(), before, 'the worker child outlived the reaper');
  await session.close();
});

await check('the reap is logged, because its cost is otherwise invisible', async () => {
  // A user who thought for five minutes and asked one more question would otherwise see a
  // multi-second wait with nothing in the log to explain it.
  const logs = [];
  const session = await makeSession(300, logs);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(
    logs.some((line) => line.includes('reaping an idle worker')),
    `no reap line was logged; got ${JSON.stringify(logs.slice(0, 4))}`
  );
  await session.close();
});

await check('signs of life reset the reaper', async () => {
  // The timer is reset by spawn, every worker message, initialize, reconfigure, send and
  // interrupt. Without that reset, a long turn would be cut off by a timer armed at spawn — a
  // five-minute turn would be killed at five minutes.
  //
  // `interrupt()` touches the reaper synchronously and only then awaits the worker's reply
  // (`#touchIdle()` is the first statement in the method). The returned promise is therefore not
  // awaited here: the touch is what this test is about, and awaiting would make the test's timing
  // depend on `CONTROL_TIMEOUT_MS` (30 s) rather than on the 700 ms window being measured.
  const logs = [];
  const session = await makeSession(700, logs);
  assert.equal(session.alive, true, 'the session did not start alive');

  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(session.alive, true, `the session reaped itself mid-activity on touch ${i}`);
    void session.interrupt().catch(() => undefined);
  }
  assert.equal(session.alive, true, 'the session reaped itself despite being touched');

  // With nothing touching it, it does reap.
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(session.alive, false, 'the session never reaped after the activity stopped');
  await session.close();
});

await check('close() is idempotent after the reaper already fired', async () => {
  const logs = [];
  const session = await makeSession(300, logs);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(session.alive, false);
  // Calling close again on a reaped session must not throw or hang.
  await session.close();
  await session.close();
});

// ── The gap the pool has to cope with ──────────────────────────────────────
await check('a reaped session still reports ready=false so the caller can rebuild', async () => {
  const logs = [];
  const session = await makeSession(300, logs);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(session.ready, false, 'a reaped session still claimed to be ready');
  await session.close();
});

await check('the reaper does not fire early', async () => {
  const logs = [];
  const session = await makeSession(2000, logs);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(session.alive, true, 'the session reaped itself well before its threshold');
  await session.close();
});

rmSync(dir, { recursive: true, force: true });

console.log(`\nidle reap: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
