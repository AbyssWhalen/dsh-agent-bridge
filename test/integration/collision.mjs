/**
 * What happens when another plugin already owns one of our provider ids.
 *
 * This is the situation `dsh-workbuddy-connect` creates: it registers `workbuddy`,
 * and so does this plugin's WorkBuddy driver. DSH accepts one adapter per provider id
 * and throws on the second, so the interesting questions are all about *how* the
 * second one fails:
 *
 *   - does `apply()` throw, taking the other component down with it?
 *   - does the surviving component still register?
 *   - is the reason visible in the log instead of only in a stack trace?
 *   - when the other plugin goes away, does the next refresh pick the id back up?
 *
 * The probe answers those by pre-registering `workbuddy` in the stand-in before
 * `apply()` runs, which is exactly the state a profile with both plugins reaches.
 *
 * Run with `node test/integration/collision.mjs`.
 */
import { apply, describe, providers } from '../../lib/index.js';

process.env.DSH_BRIDGE_POLL_MS = '5000';

const adapters = new Map();
const log = [];
const cleanups = [];

/** Pretend another plugin already serves `workbuddy`. */
const FOREIGN_LABEL = 'WorkBuddy (dsh-workbuddy-connect)';
adapters.set('workbuddy', {
  providerInfo: () => ({ id: 'workbuddy', name: FOREIGN_LABEL })
});

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

const ctx = {
  logger: {
    debug: (m) => log.push(['debug', String(m)]),
    info: (m) => log.push(['info', String(m)]),
    warn: (m) => log.push(['warn', String(m)]),
    error: (m) => log.push(['error', String(m)])
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
          adapters.set(route, adapter);
          owned.add(route);
        }
      };
      commit(routes);
      return Object.assign(() => commit([]), { replace: (next) => commit(next) });
    }
  },
  inject(dependencies, callback) {
    for (const dependency of dependencies) if (ctx[dependency] === undefined) return () => {};
    callback(ctx);
    return () => {};
  },
  webServer,
  effect(factory) {
    cleanups.push(factory());
  }
};

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

console.log('collision: another plugin already owns "workbuddy"\n');

let threw = undefined;
try {
  for (const id of providers()) apply(ctx, { component: id });
} catch (error) {
  threw = error;
}

await new Promise((resolve) => setTimeout(resolve, 22_000));

check('applying with a foreign owner present does not throw', () => {
  if (threw !== undefined) throw new Error(`apply threw: ${String(threw)}`);
});

check('the vendor that collided keeps the foreign adapter, not ours', () => {
  const info = adapters.get('workbuddy')?.providerInfo('workbuddy');
  if (info?.name !== FOREIGN_LABEL) throw new Error(`workbuddy now answers as ${JSON.stringify(info)}`);
});

check('the other vendor still registers', () => {
  if (!adapters.has('qoder')) throw new Error(`adapters: ${[...adapters.keys()]}`);
});

check('the reason is in the log, not only in a stack trace', () => {
  const said = log.filter(([level, message]) => level === 'warn' && /workbuddy/.test(message));
  if (said.length === 0) throw new Error(JSON.stringify(log.slice(-6)));
  console.log(`       log: ${said[said.length - 1][1]}`);
});

check('describe() reports the collided vendor as not serving, and why', async () => {
  const state = await describe();
  const drivers = state.drivers ?? [];
  const qoder = drivers.find((driver) => driver.id === 'qoder');
  if (qoder === undefined) throw new Error(`describe(): ${JSON.stringify(state)}`);
});

// The other plugin is removed from the profile: its adapter goes away. What this
// plugin does about that is a design decision, so the probe pins the decision rather
// than an accident: it does not keep retrying every refresh (that would log the same
// warning every five minutes forever), and flipping the row — a dispose plus a fresh
// apply, which is what the switch above the component does — takes the id back.
adapters.delete('workbuddy');
await new Promise((resolve) => setTimeout(resolve, 8_000));

check('a collided vendor is not retried on later refreshes by itself', () => {
  const info = adapters.get('workbuddy');
  if (info !== undefined) throw new Error(`workbuddy was reclaimed unattended: ${info.providerInfo('workbuddy').name}`);
});

const warningsBefore = log.filter(([level]) => level === 'warn').length;
await new Promise((resolve) => setTimeout(resolve, 6_000));
check('and it does not repeat the warning on every tick', () => {
  const now = log.filter(([level]) => level === 'warn').length;
  if (now !== warningsBefore) throw new Error(`warning count went ${warningsBefore} -> ${now}`);
});

for (const dispose of [...cleanups].reverse()) await dispose();
cleanups.length = 0;
apply(ctx, { component: 'workbuddy' });
await new Promise((resolve) => setTimeout(resolve, 15_000));

check('flipping the row claims the id back without restarting DSH', () => {
  const info = adapters.get('workbuddy')?.providerInfo('workbuddy');
  if (info === undefined) throw new Error('workbuddy is still unregistered after a fresh apply');
  if (info.name === FOREIGN_LABEL) throw new Error('the foreign adapter is still there');
  console.log(`       workbuddy now answers as: ${info.name}`);
});

for (const dispose of cleanups.reverse()) {
  try {
    await dispose();
  } catch (error) {
    console.log(`  cleanup threw: ${String(error)}`);
    failures++;
  }
}

console.log('\nfinal adapters:', JSON.stringify([...adapters.keys()]));

if (failures > 0) {
  console.log(`\n# ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\ncollision: OK');
process.exit(0);
