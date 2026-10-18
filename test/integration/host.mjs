/**
 * Integration test: load the plugin the way DSH does, without DSH.
 *
 * The plugin's real entry is `apply(ctx)`, and everything that can go wrong in it
 * is wiring rather than logic — a driver that fails to load, a member the contract
 * check rejects, a registration that throws, a catalog that never resolves. None
 * of that is covered by the per-driver live tests, and all of it is covered by
 * running `apply` against a stand-in context.
 *
 * The stand-in context is deliberately strict: `registerAdapter` rejects a second
 * adapter for the same provider, exactly as DSH does, so a vendor claimed twice
 * fails here rather than in the user's session.
 *
 * It also stands in for the harness web server, which is what lets the settings
 * routes be exercised end to end: the status document is read, one component is
 * switched off, and the other two are checked to still be serving. That is the
 * isolation the whole redesign rests on, so it is verified against the real
 * `apply`, not against a mock of it.
 *
 * Run with `node test/integration/host.mjs`.
 */
import { apply, describe, inject, providers } from '../../lib/index.js';
import { ACTION_PATH, KEY_HEADER, STATUS_PATH } from '../../lib/routes.js';

const adapters = new Map();
const log = [];

/** Stand-in for the harness web server: records handlers by path. */
function fakeWebServer() {
  const handlers = new Map();
  return {
    handlers,
    register(spec) {
      handlers.set(spec.path, spec.handler);
      return () => handlers.delete(spec.path);
    }
  };
}

const webServer = fakeWebServer();

/**
 * Invoke one mounted route the way the page would.
 *
 * @param {string} path
 * @param {{method?: string, headers?: Record<string, string>, body?: string, host?: string}} [options]
 */
async function callRoute(path, options = {}) {
  const handler = webServer.handlers.get(path);
  if (handler === undefined) throw new Error(`route not mounted: ${path}`);
  const listeners = new Map();
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')];
  let started = false;
  const req = {
    method: options.method ?? 'GET',
    headers: { host: options.host ?? '127.0.0.1:19387', ...options.headers },
    on(event, fn) {
      listeners.set(event, fn);
      if (event === 'end' && !started) {
        started = true;
        queueMicrotask(() => {
          for (const chunk of chunks) listeners.get('data')?.(chunk);
          listeners.get('end')?.();
        });
      }
      return this;
    },
    destroy() {}
  };
  const res = {
    statusCode: undefined,
    text: undefined,
    setHeader() {},
    end(text) {
      this.text = text;
    }
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.text === undefined ? undefined : JSON.parse(res.text) };
}

/** Run one settings action through the real route, key included. */
async function act(action, component, key) {
  return callRoute(ACTION_PATH, {
    method: 'POST',
    headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
    body: JSON.stringify({ action, component })
  });
}

const ctx = {
  logger: {
    debug: (message) => log.push(['debug', String(message)]),
    info: (message) => log.push(['info', String(message)]),
    warn: (message) => log.push(['warn', String(message)]),
    error: (message) => log.push(['error', String(message)])
  },
  llm: {
    registerAdapter(routes, adapter) {
      const owned = new Set();
      const commit = (next) => {
        for (const route of next) {
          if (adapters.has(route) && !owned.has(route)) {
            throw new Error(`provider "${route}" is already registered (DUPLICATE_ADAPTER)`);
          }
        }
        for (const route of owned) adapters.delete(route);
        owned.clear();
        for (const route of next) {
          // DSH re-reads `providerInfo` on every commit, which is what lets the
          // account balance reach the group header after the first refresh.
          const info = adapter.providerInfo(route);
          if (info.id !== route || typeof info.name !== 'string' || info.name.length === 0) {
            throw new Error(`adapter metadata for provider "${route}" is invalid (INVALID_ADAPTER)`);
          }
          adapters.set(route, adapter);
          owned.add(route);
        }
        routeNames.clear();
        for (const [id, current] of adapters) routeNames.set(id, current.providerInfo(id).name);
      };
      commit(routes);
      return Object.assign(() => commit([]), { replace: (next) => commit(next) });
    }
  },
  /**
   * Model dependency-gated contribution. The stand-in already provides every
   * service, so the callback runs at once — the same ordering the real context
   * gives when the service is present at boot.
   */
  inject(dependencies, callback) {
    for (const dependency of dependencies) {
      if (ctx[dependency] === undefined) return () => {};
    }
    callback(ctx);
    return () => {};
  },
  webServer,
  effect(factory) {
    cleanups.push(factory());
  }
};

/** The group label DSH would render, tracked per route across re-registrations. */
const routeNames = new Map();
const cleanups = [];

console.log('inject:   ', JSON.stringify(inject));
console.log('providers:', JSON.stringify(providers()));

apply(ctx);

// The plugin registers asynchronously so it never delays boot, and each catalogue
// does its own first fetch in the background: Qoder starts a worker runtime and
// WorkBuddy reads and unseals its credential file, which take seconds on a cold
// start. Wait for the catalogues to settle rather than guessing at a delay.
await new Promise((resolve) => setTimeout(resolve, 25_000));

console.log('\nregistered adapters:');
for (const [route, adapter] of adapters) {
  console.log(`  ${route}  provider info = ${JSON.stringify(adapter.providerInfo(route))}`);
}

console.log('\ngroup headers after the first refresh (what the picker renders once):');
for (const [route, name] of routeNames) console.log(`  ${route}: ${name}`);

console.log('\nlog:');
for (const [level, message] of log) console.log(`  [${level}] ${message}`);

console.log('\ndescribe():');
console.log(JSON.stringify(await describe(), null, 2));

// A machine with neither client installed has nothing to integrate against, and
// saying so is the honest outcome — not a pass, and not a failure with a stack
// trace that reads like a wiring bug. CI runners are exactly this machine. The
// offline suite (`npm test`) is what covers the logic there.
if (adapters.size === 0) {
  console.log('\nHost integration: SKIPPED — no vendor is installed and signed in here.');
  console.log('  The offline suite (npm test) is the part that can run without any client.');
  for (const [level, message] of log) {
    if (level === 'warn' || level === 'error') console.log(`  [${level}] ${message}`);
  }
  for (const cleanup of cleanups) await cleanup().catch(() => {});
  process.exit(0);
}

/* ------------------------------------------------------------------ routes */

console.log('\n=== settings routes ===');

const first = await callRoute(STATUS_PATH);
if (first.status !== 200) throw new Error(`status route answered ${first.status}`);
console.log(`status: 200, key present: ${typeof first.body.key === 'string'}`);
for (const component of first.body.components) {
  const quota = component.quota === undefined ? 'none' : JSON.stringify(component.quota).slice(0, 90);
  console.log(
    `  ${component.id.padEnd(10)} state=${String(component.state).padEnd(8)} ` +
      `models=${String((component.models ?? []).length).padStart(2)} quota=${quota}`
  );
  if (component.located !== undefined) console.log(`             account: ${JSON.stringify(component.located)}`);
}

const key = first.body.key;

console.log('\nrefusals:');
const noKey = await callRoute(ACTION_PATH, { method: 'POST', body: '{"action":"disable","component":"qoder"}' });
console.log(`  no key            -> ${noKey.status} ${JSON.stringify(noKey.body)}`);
const badHost = await callRoute(STATUS_PATH, { host: 'evil.example.com' });
console.log(`  non-loopback host -> ${badHost.status} ${JSON.stringify(badHost.body)}`);

console.log('\nisolation: switch Qoder off, leave the others running');
const off = await act('disable', 'qoder', key);
console.log(`  action -> ${off.status}, ok=${off.body.ok}`);
for (const component of off.body.status.components) {
  console.log(`  ${component.id.padEnd(10)} state=${component.state}`);
}
console.log(`  adapters still registered: ${[...adapters.keys()].join(', ') || '(none)'}`);
if (adapters.has('qoder')) throw new Error('Qoder kept its provider route after being switched off');
if (!adapters.has('workbuddy')) throw new Error('switching Qoder off also removed WorkBuddy');

console.log('\nre-enable Qoder');
const on = await act('enable', 'qoder', key);
console.log(`  action -> ${on.status}, ok=${on.body.ok}`);
for (const component of on.body.status.components) {
  console.log(`  ${component.id.padEnd(10)} state=${component.state}`);
}
if (!adapters.has('qoder')) throw new Error('Qoder did not come back after being switched on');

// A component whose driver files are parked is the only state that cannot run.
// Park/restore itself is covered by test/components.mjs against a scratch root,
// where a mistake cannot leave an installed package missing a driver.
console.log('\nuninstall guard: a removed component refuses to be switched on');
const removed = await callRoute(ACTION_PATH, {
  method: 'POST',
  headers: { [KEY_HEADER]: key },
  body: JSON.stringify({ action: 'enable', component: 'nope' })
});
console.log(`  unknown component -> ${removed.status} ${JSON.stringify(removed.body)}`);
if (removed.body?.ok !== false) throw new Error('an unknown component was accepted');

// Exercise the two adapter methods the GUI actually calls, per provider.
console.log('\nlistModels + resolveModel:');
for (const [route, adapter] of adapters) {
  let models;
  try {
    models = await adapter.listModels(route);
  } catch (error) {
    console.log(`  ${route}: listModels failed: ${error.message}`);
    continue;
  }
  console.log(`  ${route}: ${models.length} model(s)`);
  if (models.length === 0) continue;
  const first = models[0];
  console.log(`    first: ${first.id} "${first.name}"`);
  try {
    const info = await adapter.resolveModel(route, first.id);
    console.log(
      `    resolved: ctx=${info.context.contextWindow} max=${info.defaultMaxTokens} ` +
        `reasoning=${info.reasoning === undefined ? 'none' : info.reasoning.efforts.map((entry) => entry.id).join('|')}`
    );
  } catch (error) {
    console.log(`    resolveModel failed: ${error.message}`);
  }
  // A provider whose catalog is empty must still answer cleanly, because the
  // selection UI asks about every model it has ever seen.
  try {
    await adapter.resolveModel(route, '__not_a_model__');
    console.log('    unexpected: an unknown model resolved');
  } catch (error) {
    console.log(`    unknown model rejected: ${error.message.slice(0, 90)}`);
  }
}

console.log('\ncleanup:');
for (const cleanup of cleanups) {
  try {
    await cleanup();
  } catch (error) {
    console.log(`  cleanup failed: ${error.message}`);
  }
}
console.log('  done');
console.log(`\nadapters remaining after cleanup: ${adapters.size}`);

// A live child process left behind is the visible symptom of a teardown that did
// not reach the driver. A child that has been signalled but not yet reaped still
// counts as an active handle, so give it a moment before deciding.
await new Promise((resolve) => setTimeout(resolve, 1500));
const handles = process._getActiveHandles?.() ?? [];
const lingering = handles.filter((handle) => handle?.constructor?.name === 'ChildProcess');
console.log(`lingering child processes after cleanup: ${lingering.length}`);
for (const handle of lingering) console.log(`  pid ${handle.pid} ${handle.spawnfile ?? ''}`);

console.log('\nHost integration: OK');
process.exit(0);
