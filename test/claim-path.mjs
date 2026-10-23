/**
 * Offline: the adapter's own claim path under contention.
 *
 * `test/pool-concurrency.mjs` proves the pool's rules. This file proves the thing those rules
 * exist for: what `Adapter.stream` actually does when two turns arrive for one `sessionId`.
 *
 * The claim path is the one place the plugin decides whether a turn shares an upstream session or
 * gets its own. Three outcomes, and each was chosen deliberately (`lib/adapter.js` `#claim`):
 *
 * - **absent** → open one and keep it.
 * - **busy** → open a throwaway beside it, because refusing would fail a turn that could have been
 *   served. The desktop app and a headless run share a session id in practice.
 * - **saturated** → same as busy. Every pooled entry is mid-turn, so a new one must be opened or
 *   the turn waits behind work that may take minutes.
 *
 * The failure this file is built to catch is **cross-talk**: the second turn receiving the first
 * turn's session. Nothing in a single-turn test can see it, and on a stateful worker the symptom
 * is a conversation that contains someone else's question.
 *
 * Run with `node test/claim-path.mjs`.
 */
import assert from 'node:assert/strict';
import { MAX_SESSIONS } from '../lib/adapter.js';

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
 * A driver stub that records every session it opens and what each one was asked to do.
 *
 * The delay is what makes contention observable: without it the first turn finishes before the
 * second starts and the busy branch is never reached, which would make every assertion here true
 * and pointless.
 */
function stubDriver({ delayMs = 30 } = {}) {
  const opened = [];
  let nextId = 0;
  return {
    opened,
    async openSession({ key }) {
      const id = `s${nextId++}`;
      const session = {
        id,
        key,
        closed: false,
        prompts: [],
        close() {
          this.closed = true;
        },
        async *send(messages) {
          session.prompts.push(messages.map((m) => m.text ?? '').join('|'));
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          yield { type: 'text-delta', text: `reply from ${id}` };
          yield { type: 'finish', finish: { kind: 'stop' } };
        }
      };
      opened.push(session);
      return session;
    }
  };
}

/** Drain one stream turn and return what came out. */
async function turn(adapter, options) {
  let text = '';
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text ?? '';
  }
  return text;
}

const userTurn = (text) => [{ role: 'user', content: [{ type: 'text', text }] }];

// ── The budget the claim path is written against ─────────────────────────────
await check('the session budget is a positive integer', () => {
  assert.ok(Number.isInteger(MAX_SESSIONS) && MAX_SESSIONS > 0, `MAX_SESSIONS is ${MAX_SESSIONS}`);
});

// ── Two turns, one session id ────────────────────────────────────────────────
await check('two concurrent turns on one session id get different sessions', async () => {
  const driver = stubDriver();
  const adapter = await makeAdapter(driver);

  const [first, second] = await Promise.all([
    turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('one') }),
    turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('two') })
  ]);

  assert.notEqual(first, second, 'both turns were answered by the same session');
  assert.equal(driver.opened.length, 2, `opened ${driver.opened.length} sessions`);

  // The proof that they really overlapped: the two sessions each saw exactly one prompt, so
  // neither was reused mid-flight.
  const prompts = driver.opened.map((session) => session.prompts.join(';'));
  assert.equal(prompts.filter((p) => p.includes('one')).length, 1, `prompt "one" visited ${prompts.join(' / ')}`);
  assert.equal(prompts.filter((p) => p.includes('two')).length, 1);
  await adapter.close?.();
});

await check('two turns on one fresh key never share a pool entry (F-045)', async () => {
  // The race `#claim` has to close: `take` reports `absent` until a handle exists, so two turns
  // arriving together both open a session and both want to register under the same key. The second
  // registration overwrites the first, and the overwritten handle keeps a live upstream with
  // nothing left to close it.
  //
  // Measured on Qoder before the fix — a worker child outlived `close()` with no signal sent:
  //     BEFORE CLOSE: [ 24988, 7220, 23100 ]
  //     AFTER CLOSE:  [ {pid:24988, sig:'SIGTERM'}, {pid:7220, sig:null} ]
  //     AT +3s:       [ {pid:7220, sig:null} ]
  //
  // This test states the invariant, not the symptom: for one fresh key, the driver must open
  // exactly **one** session under that key. Any second open under the same key is a session the
  // pool cannot hold a reference to, whatever happens to it afterwards. Counting closes instead
  // would stay green as long as *some* layer cleans up, which is why the earlier form of this
  // check could not see the race at all.
  const driver = stubDriver();
  const adapter = await makeAdapter(driver);
  await Promise.all([
    turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('one') }),
    turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('two') })
  ]);
  await adapter.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const plain = driver.opened.filter((session) => session.key === 'S');
  assert.equal(
    plain.length,
    1,
    `one fresh key opened ${plain.length} sessions (${plain.map((s) => s.id).join(', ')}); the extra has no owner in the pool`
  );
  const leaked = driver.opened.filter((session) => !session.closed);
  assert.deepEqual(leaked.map((s) => s.id), [], 'a session the driver opened was never closed');
});

await check('the second turn does not land in the first turn\'s session', async () => {
  const driver = stubDriver();
  const adapter = await makeAdapter(driver);

  const started = Date.now();
  let firstStarted = 0;
  let secondStarted = 0;
  const runs = [
    turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('alpha') }).then((text) => {
      firstStarted = started;
      return text;
    }),
    (async () => {
      secondStarted = Date.now();
      return turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('beta') });
    })()
  ];
  await Promise.all(runs);

  const owning = driver.opened.map((session) => ({
    id: session.id,
    saw: session.prompts.join(';')
  }));
  assert.equal(owning.filter((o) => o.saw.includes('alpha')).length, 1, `alpha in ${JSON.stringify(owning)}`);
  assert.equal(owning.filter((o) => o.saw.includes('beta')).length, 1, `beta in ${JSON.stringify(owning)}`);
  assert.ok(secondStarted - firstStarted < 30, 'the second turn did not start alongside the first');
  await adapter.close?.();
});

// ── Sequential turns must reuse, which is the whole point of pooling ────────
await check('a second turn after the first finishes reuses the session', async () => {
  const driver = stubDriver({ delayMs: 1 });
  const adapter = await makeAdapter(driver);

  await turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('first') });
  await turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('second') });

  assert.equal(driver.opened.length, 1, `opened ${driver.opened.length} sessions for two sequential turns`);
  await adapter.close?.();
});

// ── Saturation forces a new session rather than an unserved turn ────────────
await check('turns beyond the budget are still served', async () => {
  const driver = stubDriver({ delayMs: 40 });
  const adapter = await makeAdapter(driver);

  const texts = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      turn(adapter, { provider: 'stub', model: 'm', sessionId: `S${i}`, messages: userTurn(`q${i}`) })
    )
  );
  assert.equal(texts.length, 5);
  assert.ok(texts.every((text) => text.startsWith('reply from')), `a turn produced ${JSON.stringify(texts)}`);
  await adapter.close?.();
});

// ── Overflow sessions do not survive their turn ─────────────────────────────
await check('a busy key is never handed to a second turn', async () => {
  // The direct statement of the cross-talk rule. The shape of the breakage matters here: when
  // `#claim` reuses the key instead of opening an overflow, it calls `openSession` again and
  // `put`s the new handle over the old one — so two live sessions end up under one pool key. Each
  // still sees exactly one prompt, which is why "one session was asked two questions" never goes
  // red; the observable fact is that the *same key* opened twice while the first was still running.
  const driver = stubDriver({ delayMs: 60 });
  const adapter = await makeAdapter(driver);

  const held = turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('first-question') });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('second-question') });
  await Promise.all([held, second]);

  const plainKeyOpens = driver.opened.filter((session) => session.key === 'S');
  assert.equal(
    plainKeyOpens.length,
    1,
    `one session id was opened ${plainKeyOpens.length} times; the extra handle is orphaned with no owner in the pool`
  );
  await adapter.close?.();
});

await check('overflow sessions are closed when their turn ends', async () => {
  const driver = stubDriver({ delayMs: 60 });
  const adapter = await makeAdapter(driver);

  // The first turn must be *in the pool and busy* before the second arrives. Two turns started in
  // the same tick both find the key `absent` — each awaits `openSession` before either has been
  // `put`, so they open two ordinary sessions and the busy branch is never reached. Measured: that
  // is why the first version of this test reported "no overflow session was opened".
  const held = turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('one') });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('two') });
  await Promise.all([held, second]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const overflow = driver.opened.filter((session) => session.key.includes('#'));
  assert.ok(overflow.length >= 1, `no overflow session was opened; keys were ${JSON.stringify(driver.opened.map((s) => s.key))}`);
  assert.ok(
    overflow.every((session) => session.closed),
    `an overflow session outlived its turn: ${JSON.stringify(overflow.map((s) => [s.key, s.closed]))}`
  );
  await adapter.close?.();
});

await check('the pooled session survives an overflow ending', async () => {
  const driver = stubDriver({ delayMs: 60 });
  const adapter = await makeAdapter(driver);

  const held = turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('one') });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = turn(adapter, { provider: 'stub', model: 'm', sessionId: 'S', messages: userTurn('two') });
  await Promise.all([held, second]);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const primary = driver.opened.find((session) => !session.key.includes('#'));
  assert.ok(primary !== undefined, 'no primary session was opened');
  assert.equal(primary.closed, false, 'the pooled session was closed when the overflow ended');
  await adapter.close?.();
});

console.log(`\nclaim path: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/** A logger that stays quiet: this file's output is the test report. */
function quiet() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * A catalog with the one model these turns ask for.
 *
 * `DriverAdapter` takes the catalog as a dependency and calls `current()` on it, so a stub that
 * only answers `find` is not enough.
 */
function stubCatalog() {
  const rows = [{ id: 'm', name: 'm', contextWindow: 100_000, maxTokens: 4_000 }];
  return { current: () => rows, refresh: async () => rows };
}

/**
 * Build the adapter the way the plugin does, with a driver stub in place of a real one.
 *
 * The budget is **not** a parameter: `DriverAdapter` hard-codes `MAX_SESSIONS` when it constructs
 * its pool. A test that passed its own budget would be measuring a configuration the product does
 * not ship.
 */
async function makeAdapter(driver) {
  const { DriverAdapter } = await import('../lib/adapter.js');
  return new DriverAdapter({ provider: 'stub', displayName: 'stub', driver, logger: quiet(), catalog: stubCatalog() });
}
