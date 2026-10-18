/**
 * Soak: repeated switch cycles plus live timer ticks, then a clean teardown.
 *
 * The other host-side tests each prove one thing once. A plugin that lives inside a
 * running DSH does not fail that way: it fails on the tenth switch cycle, when a
 * released route is registered again, or when a toggle lands while a refresh is
 * still in flight. Those are sequencing bugs, and repetition is the only way to see
 * them here.
 *
 * **A switch is a disposal, not a flag.** In this plugin's row mode the switch above
 * each component is DSH's own: flipping it disposes that row's instance. So each
 * round below disposes one component's effects for real, checks that the other keeps
 * serving, then applies the component again and checks it comes back with its models
 * — which is what the user actually does all day, and the sequence that would leak an
 * adapter or re-register a released route if the teardown order were wrong.
 *
 * Run with `node test/integration/soak.mjs` (`-Rounds=N` to change the count).
 */
import { apply, describe, providers } from '../../lib/index.js';
import { ACTION_PATH, KEY_HEADER } from '../../lib/routes.js';

const roundsArg = process.argv.find((value) => value.startsWith('-Rounds='));
const ROUNDS = roundsArg === undefined ? 8 : Number(roundsArg.slice('-Rounds='.length));

process.env.DSH_BRIDGE_POLL_MS = '5000';

const adapters = new Map();
const log = [];

function fakeWebServer() {
  const handlers = new Map();
  return {
    handlers,
    register(spec) {
      if (handlers.has(spec.path)) throw new Error(`route already mounted: ${spec.path}`);
      handlers.set(spec.path, spec.handler);
      return () => handlers.delete(spec.path);
    }
  };
}

const webServer = fakeWebServer();
const routeNames = new Map();
/** Effects registered by the component currently being applied. */
let sink = [];
/** Effects per component, so one row can be disposed the way DSH does it. */
const perComponent = new Map();

async function callRoute(path, options = {}) {
  const handler = webServer.handlers.get(path);
  if (handler === undefined) throw new Error(`route not mounted: ${path}`);
  const listeners = new Map();
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body, 'utf8')];
  let started = false;
  const req = {
    method: options.method ?? 'GET',
    headers: { host: '127.0.0.1:19387', ...options.headers },
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
          const info = adapter.providerInfo(route);
          if (info.id !== route) throw new Error(`adapter metadata for "${route}" is invalid`);
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
  inject(dependencies, callback) {
    for (const dependency of dependencies) if (ctx[dependency] === undefined) return () => {};
    callback(ctx);
    return () => {};
  },
  webServer,
  effect(factory) {
    const dispose = factory();
    sink.push(dispose);
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

function mount(id) {
  sink = [];
  apply(ctx, { component: id });
  const effects = sink;
  perComponent.set(id, effects);
}

async function unmount(id) {
  const effects = perComponent.get(id) ?? [];
  perComponent.delete(id);
  // Cordis awaits a disposer's promise; doing the same here is what keeps this
  // probe honest — skipping the await lets the next mount race a live teardown.
  for (const dispose of [...effects].reverse()) await dispose();
}

const ids = [...providers()].sort();
const statusPath = (id) => `/plugins/dsh-agent-bridge/${id}/status`;
const actionPath = (id) => `/plugins/dsh-agent-bridge/${id}/action`;

console.log(`soak: ${ROUNDS} rounds, poll 5s, components ${ids.join(' + ')}\n`);

for (const id of ids) mount(id);

await new Promise((resolve) => setTimeout(resolve, 20_000));

const first = await callRoute(statusPath(ids[0]));
const key = first.body?.key;
if (typeof key !== 'string') throw new Error(`no key in the status document: ${JSON.stringify(first)}`);

async function act(id, action) {
  return callRoute(actionPath(id), {
    method: 'POST',
    headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
    body: JSON.stringify({ action, component: id })
  });
}

async function models(id) {
  const body = (await callRoute(statusPath(id))).body;
  return body.components[0].models.length;
}

const [target, other] = ids;

for (let round = 1; round <= ROUNDS; round++) {
  const beforeTarget = await models(target);
  const beforeOther = await models(other);

  await unmount(target);

  const otherStillThere = adapters.has(other);
  const targetGone = !adapters.has(target);
  const routesGone = !webServer.handlers.has(statusPath(target));

  mount(target);
  await new Promise((resolve) => setTimeout(resolve, 12_000));

  const afterTarget = await models(target);
  const afterOther = await models(other);

  console.log(
    `  round ${String(round).padStart(2)}  ${target} ${beforeTarget}->${afterTarget}  ` +
      `${other} ${beforeOther}->${afterOther}  adapters:${adapters.size}  ` +
      `off:${targetGone ? 'gone' : 'STILL'}${routesGone ? '/routes gone' : '/ROUTES STILL'}`
  );

  check(`round ${round}: the survivor keeps serving while the other is switched off`, () => {
    if (!targetGone) throw new Error(`${target} stayed registered after disposal`);
    if (!routesGone) throw new Error(`${target}'s route survived disposal`);
    if (!otherStillThere) throw new Error(`${other} was unregistered when ${target} went away`);
  });

  check(`round ${round}: the adapter map holds exactly one entry per component`, () => {
    if (adapters.size !== ids.length) throw new Error(`adapters.size is ${adapters.size}`);
    for (const id of ids) {
      if (adapters.get(id)?.providerInfo(id).id !== id) throw new Error(`${id} answers for another provider`);
    }
  });

  check(`round ${round}: the component comes back with its models`, () => {
    if (afterTarget !== beforeTarget) throw new Error(`${target}: ${beforeTarget} -> ${afterTarget}`);
    if (afterOther !== beforeOther) throw new Error(`${other}: ${beforeOther} -> ${afterOther}`);
  });
}

// A refresh through the real route, twice, to prove the on-demand path also settles.
for (let attempt = 1; attempt <= 2; attempt++) {
  for (const id of ids) {
    const answer = await act(id, 'refresh');
    if (answer.status !== 200) throw new Error(`refresh ${id} answered ${answer.status}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

check('two on-demand refreshes leave both components serving', async () => {
  for (const id of ids) {
    if ((await models(id)) === 0) throw new Error(`${id} lost its models after a refresh`);
  }
});

check('the row-mode switch refuses a second switch instead of disagreeing with it', async () => {
  const answer = await act(target, 'disable');
  if (answer.status !== 200 || answer.body.ok !== false) {
    throw new Error(`disable answered ${answer.status} ${JSON.stringify(answer.body)}`);
  }
  if (!/switch/i.test(String(answer.body.reason))) throw new Error(`unhelpful reason: ${answer.body.reason}`);
  if (!adapters.has(target)) throw new Error('the refusing disable still unregistered the component');
});

// One more timer tick with everything running, then teardown.
await new Promise((resolve) => setTimeout(resolve, 7_000));

const warnings = log.filter(([level]) => level === 'warn' || level === 'error');
check('no warnings or errors were logged across the whole run', () => {
  if (warnings.length > 0) throw new Error(JSON.stringify(warnings.slice(0, 4)));
});

for (const id of ids) await unmount(id);
await new Promise((resolve) => setTimeout(resolve, 4_000));

check('teardown leaves no adapter behind', () => {
  if (adapters.size !== 0) throw new Error(`${adapters.size} adapter(s) survived: ${[...adapters.keys()]}`);
});

check('teardown leaves no route behind', () => {
  if (webServer.handlers.size !== 0) throw new Error(`routes still mounted: ${[...webServer.handlers.keys()]}`);
});

console.log('\ndescribe():', JSON.stringify(await describe()));

if (failures > 0) {
  console.log(`\n# ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nsoak: OK (${ROUNDS} rounds)`);
process.exit(0);
