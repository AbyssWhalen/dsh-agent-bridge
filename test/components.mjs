/**
 * Offline verification of the components page's host half.
 *
 * Three claims are checked, each of which would otherwise only fail in front of
 * the user:
 *
 *   1. the switch is per vendor — disabling one leaves the others mounted
 *   2. a removed vendor reports `removed`, not `off`, and restore brings the files
 *      back without silently re-enabling it
 *   3. the routes refuse a caller that is not loopback or has no key, because a
 *      state-changing route reachable by a guessed path is the one thing here that
 *      could actually cause harm
 *
 * Runs entirely against a temporary DSH home and a stand-in web server, so it
 * never touches the profile or the vendor apps.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'agent-bridge-test-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'drivers'), { recursive: true });

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

console.log(`# DSH_HOME = ${home}`);

/* -------------------------------------------------------------------- state */

const state = await import('../lib/state.js');

await check('a fresh install serves every component', () => {
  const { state: fresh, note } = state.readState();
  assert.equal(note, undefined);
  for (const id of state.COMPONENT_IDS) assert.equal(state.componentState(fresh, id), 'on');
});

await check('a damaged state file falls back to all-on and reports why', () => {
  writeFileSync(join(home, 'agent-bridge-state.json'), '{ not json', 'utf8');
  const { state: recovered, note } = state.readState();
  assert.ok(typeof note === 'string' && note.length > 0);
  assert.equal(state.componentState(recovered, 'qoder'), 'on');
});

await check('an unknown component id from a later version is dropped', () => {
  state.writeState({ version: 1, disabled: ['qoder', 'brand-new-vendor'], removed: [] });
  const { state: read } = state.readState();
  assert.deepEqual(read.disabled, ['qoder']);
});

await check('removed outranks disabled', () => {
  const doc = { version: 1, disabled: ['qoder'], removed: ['qoder'] };
  assert.equal(state.componentState(doc, 'qoder'), 'removed');
});

await check('a state round-trip preserves the choice', () => {
  state.writeState({ version: 1, disabled: ['qoder'], removed: [] });
  assert.equal(state.componentState(state.readState().state, 'qoder'), 'off');
  assert.equal(state.componentState(state.readState().state, 'workbuddy'), 'on');
});

await check('the host key is stable within a process and not guessable', () => {
  const a = state.hostKey();
  assert.equal(a, state.hostKey());
  assert.match(a, /^[0-9a-f]{32}$/);
});

/* ------------------------------------------------------------- route guards */

const routes = await import('../lib/routes.js');

/** A stand-in for the harness web server: records handlers by path. */
function fakeWebServer() {
  const handlers = new Map();
  const cancelled = [];
  return {
    handlers,
    cancelled,
    register(spec) {
      handlers.set(spec.path, spec.handler);
      return () => {
        cancelled.push(spec.path);
        handlers.delete(spec.path);
      };
    }
  };
}

/**
 * A minimal request/response pair good enough for the handlers under test.
 *
 * The body is emitted when the handler subscribes to `end`, not on a fixed
 * schedule: the action handler awaits the bridge before it reads the body, and a
 * fake that fired earlier would resolve a promise the handler is not yet waiting
 * on — which hangs the test rather than failing it.
 */
function request({ method = 'GET', host = '127.0.0.1:19387', origin, headers = {}, body } = {}) {
  const listeners = new Map();
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  let started = false;
  function start() {
    if (started) return;
    started = true;
    queueMicrotask(() => {
      for (const chunk of chunks) listeners.get('data')?.(chunk);
      listeners.get('end')?.();
    });
  }
  const req = {
    method,
    headers: { host, ...(origin === undefined ? {} : { origin }), ...headers },
    on(event, fn) {
      listeners.set(event, fn);
      if (event === 'end') start();
      return this;
    },
    destroy() {
      /* the handler only calls this on an oversized body */
    }
  };
  const res = {
    statusCode: undefined,
    headers: {},
    text: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(text) {
      this.text = text;
    }
  };
  return { req, res };
}

function fakeBridge() {
  const calls = [];
  const document = { status: 'ok', package: 'dsh-agent-bridge', key: 'k'.repeat(32), components: [] };
  return {
    calls,
    snapshot: async () => document,
    setEnabled: async (id, on) => {
      calls.push(['setEnabled', id, on]);
      return { ok: true };
    },
    uninstall: async (id) => {
      calls.push(['uninstall', id]);
      return { ok: true };
    },
    restore: async (id) => {
      calls.push(['restore', id]);
      return { ok: true };
    },
    refresh: async (id) => {
      calls.push(['refresh', id]);
      return { ok: true };
    }
  };
}

const server = fakeWebServer();
const bridge = fakeBridge();
const effects = [];
const fakeCtx = {
  webServer: server,
  effect(factory) {
    const dispose = factory();
    effects.push(dispose);
    return dispose;
  }
};
routes.registerRoutes(fakeCtx, bridge);

await check('every hosted vendor gets its own pair, plus the aggregate', () => {
  // Four pairs: one per vendor and the aggregate, because a row's page addresses
  // exactly one vendor and must not have to pick it out of a wider document.
  for (const id of state.COMPONENT_IDS) {
    const paths = routes.pathsFor(id);
    assert.ok(server.handlers.has(paths.status), `${id}: status route missing`);
    assert.ok(server.handlers.has(paths.action), `${id}: action route missing`);
  }
  assert.ok(server.handlers.has(routes.STATUS_PATH), 'aggregate status route missing');
  assert.ok(server.handlers.has(routes.ACTION_PATH), 'aggregate action route missing');
});

/** Invoke one handler and return its response. */
async function call(path, options) {
  const handler = server.handlers.get(path);
  const { req, res } = request(options);
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.text === undefined ? undefined : JSON.parse(res.text) };
}

await check('status answers a loopback GET', async () => {
  const result = await call(routes.STATUS_PATH, {});
  assert.equal(result.status, 200);
  assert.equal(result.body.package, 'dsh-agent-bridge');
});

await check('status refuses a non-loopback Host (DNS rebinding)', async () => {
  const result = await call(routes.STATUS_PATH, { host: 'evil.example.com' });
  assert.equal(result.status, 403);
});

await check('status refuses a non-loopback Origin', async () => {
  const result = await call(routes.STATUS_PATH, { origin: 'https://evil.example.com' });
  assert.equal(result.status, 403);
});

await check('status refuses a POST', async () => {
  const result = await call(routes.STATUS_PATH, { method: 'POST' });
  assert.equal(result.status, 405);
});

await check('action refuses a POST with no key', async () => {
  const result = await call(routes.ACTION_PATH, {
    method: 'POST',
    body: JSON.stringify({ action: 'disable', component: 'qoder' })
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'bad-key');
  assert.equal(bridge.calls.length, 0, 'a refused request must not change state');
});

await check('action refuses a wrong key', async () => {
  const result = await call(routes.ACTION_PATH, {
    method: 'POST',
    headers: { [routes.KEY_HEADER]: 'nope' },
    body: JSON.stringify({ action: 'disable', component: 'qoder' })
  });
  assert.equal(result.status, 403);
  assert.equal(bridge.calls.length, 0);
});

await check('action performs the switch once the key matches', async () => {
  const result = await call(routes.ACTION_PATH, {
    method: 'POST',
    headers: { [routes.KEY_HEADER]: 'k'.repeat(32) },
    body: JSON.stringify({ action: 'disable', component: 'qoder' })
  });
  assert.equal(result.status, 200);
  assert.deepEqual(bridge.calls, [['setEnabled', 'qoder', false]]);
});

await check('an unknown action is refused without touching the bridge', async () => {
  bridge.calls.length = 0;
  const result = await call(routes.ACTION_PATH, {
    method: 'POST',
    headers: { [routes.KEY_HEADER]: 'k'.repeat(32) },
    body: JSON.stringify({ action: 'self-destruct', component: 'qoder' })
  });
  assert.equal(result.status, 400);
  assert.equal(bridge.calls.length, 0);
});

await check('a non-JSON body is a 400, not a crash', async () => {
  const result = await call(routes.ACTION_PATH, {
    method: 'POST',
    headers: { [routes.KEY_HEADER]: 'k'.repeat(32) },
    body: 'not json at all'
  });
  assert.equal(result.status, 400);
});

await check('disposing the plugin unregisters every route it mounted', () => {
  const mounted = server.handlers.size;
  assert.equal(mounted, state.COMPONENT_IDS.length * 2 + 2, 'expected one status/action pair per vendor plus the aggregate');
  for (const dispose of effects) dispose();
  assert.equal(server.handlers.size, 0);
  assert.equal(server.cancelled.length, mounted);
});

/* ------------------------------------------------------- uninstall isolation */

/**
 * A stand-in package root.
 *
 * The park/restore checks deliberately run against this instead of the real
 * package: an uninstall test that moved a real driver out of an installed plugin
 * would be a test that damages the thing it is testing.
 */
const scratchRoot = join(home, 'package');
mkdirSync(join(scratchRoot, 'drivers'), { recursive: true });

await check('park and restore round-trip a driver directory', () => {
  const id = 'qoder';
  const source = state.driverDir(id, scratchRoot);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.js'), 'export const driver = {};\n', 'utf8');

  assert.equal(state.hasParkedCopy(id), false);
  const parked = state.parkDriver(id, scratchRoot);
  assert.equal(parked.ok, true, parked.reason);
  assert.equal(existsSync(source), false, 'the driver must leave the package');
  assert.equal(state.hasParkedCopy(id), true);
  assert.equal(readFileSync(join(parked.parkedAt, 'index.js'), 'utf8'), 'export const driver = {};\n');

  const restored = state.restoreDriver(id, scratchRoot);
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(existsSync(join(source, 'index.js')), true);
  assert.equal(state.hasParkedCopy(id), false);
});

await check('parking an absent driver reports rather than throws', () => {
  const result = state.parkDriver('workbuddy', scratchRoot);
  assert.equal(result.ok, false);
  assert.match(result.reason, /already absent/);
});

await check('restoring an absent copy reports rather than throws', () => {
  const result = state.restoreDriver('workbuddy', scratchRoot);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no parked copy/);
});

await check('park leaves the other components untouched', () => {
  const keep = state.driverDir('workbuddy', scratchRoot);
  mkdirSync(keep, { recursive: true });
  writeFileSync(join(keep, 'index.js'), 'export const driver = { id: "workbuddy" };\n', 'utf8');
  const other = state.driverDir('qoder', scratchRoot);
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'index.js'), 'export const driver = {};\n', 'utf8');

  assert.equal(state.parkDriver('qoder', scratchRoot).ok, true);
  assert.equal(existsSync(join(keep, 'index.js')), true, 'the other component must survive');
  assert.equal(readFileSync(join(keep, 'index.js'), 'utf8'), 'export const driver = { id: "workbuddy" };\n');
});

await check('the real package drivers are never the subject of park/restore', () => {
  // This check exists because an earlier draft of this file wrote into the real
  // package and clobbered a driver. A test that can damage the thing it tests is
  // worse than no test, so the separation is asserted rather than assumed.
  for (const id of state.COMPONENT_IDS) {
    assert.notEqual(state.driverDir(id), state.driverDir(id, scratchRoot), `${id} resolves to the real package`);
  }
  const real = state.driverDir('qoder');
  assert.equal(real.startsWith(scratchRoot), false);
  // ...and the real drivers still hold their real content.
  for (const id of state.COMPONENT_IDS) {
    const main = join(state.driverDir(id), 'index.js');
    const text = readFileSync(main, 'utf8');
    assert.ok(text.length > 1000, `${id}/index.js looks truncated (${text.length} bytes)`);
    assert.doesNotMatch(text, /^export const driver = \{\};$/m, `${id}/index.js is a stub`);
  }
});

rmSync(home, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n# ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n# components: OK');
