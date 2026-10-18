/**
 * A refresh has to be a refresh.
 *
 * The catalog shares one pass between overlapping calls, and the bug this pins is
 * that sharing never ending: the settled promise stayed in place, so every later
 * refresh returned it and did no work. The visible symptom was a balance frozen at
 * whatever it read during boot — a number that looked live and never moved.
 *
 * Offline on purpose: fake readers, no worker, no network.
 *
 * Run with `node test/catalog-refresh.mjs`.
 */
import { Catalog } from '../lib/catalog.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('# a settled pass does not block the next one\n');

let listCalls = 0;
let quotaCalls = 0;
const counting = new Catalog({
  listModels: async () => {
    listCalls += 1;
    return [{ id: `m${listCalls}` }];
  },
  normalize: (raw) => raw,
  quota: async () => {
    quotaCalls += 1;
    return { remaining: 100 - quotaCalls };
  },
  label: 'counting'
});

await counting.refresh();
await counting.refresh();
await counting.refresh();

check('three refreshes read the balance three times', () => {
  assert(quotaCalls === 3, `expected 3 quota reads, saw ${quotaCalls}`);
});
check('three refreshes list the models three times', () => {
  assert(listCalls === 3, `expected 3 listings, saw ${listCalls}`);
});
check('the published balance is the latest reading', () => {
  assert(counting.quota()?.remaining === 97, `got ${JSON.stringify(counting.quota())}`);
});
check('the published model is the latest row', () => {
  assert(counting.current()[0]?.id === 'm3', `got ${JSON.stringify(counting.current())}`);
});

console.log('\n# overlapping calls still share one pass\n');

let slowList = 0;
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const shared = new Catalog({
  listModels: async () => {
    slowList += 1;
    await gate;
    return [{ id: 'x' }];
  },
  normalize: (raw) => raw,
  quota: async () => ({ remaining: 5 }),
  label: 'shared'
});

const first = shared.refresh();
const second = shared.refresh();
check('a second call while one is in flight returns the same promise', () => {
  assert(first === second, 'a concurrent refresh started its own pass');
});
release();
await first;
check('the shared pass ran once', () => {
  assert(slowList === 1, `expected 1 listing, saw ${slowList}`);
});

console.log('\n# a failure keeps the last good balance, then recovers\n');

let failNow = false;
let value = 42;
const shaky = new Catalog({
  listModels: async () => [{ id: 's' }],
  normalize: (raw) => raw,
  quota: async () => {
    if (failNow) throw new Error('quota request failed (http 401)');
    return { remaining: value };
  },
  label: 'shaky'
});

await shaky.refresh();
check('the first balance is published', () => {
  assert(shaky.quota()?.remaining === 42, `got ${JSON.stringify(shaky.quota())}`);
});

failNow = true;
await shaky.refresh();
check('a failed read keeps the previous figure instead of blanking it', () => {
  assert(shaky.quota()?.remaining === 42, `got ${JSON.stringify(shaky.quota())}`);
});

failNow = false;
value = 7;
await shaky.refresh();
check('and the next successful read replaces it', () => {
  assert(shaky.quota()?.remaining === 7, `got ${JSON.stringify(shaky.quota())}`);
});

console.log('\n# a balance that cannot be read stops being claimed\n');

let clock = 1_000_000;
let broken = false;
let liveValue = 500;
const timing = new Catalog({
  listModels: async () => [{ id: 't' }],
  normalize: (raw) => raw,
  quota: async () => {
    if (broken) throw new Error('quota request failed (http 500)');
    return { remaining: liveValue };
  },
  label: 'timing',
  now: () => clock
});

await timing.refresh();
check('the balance is published while the reader works', () => {
  assert(timing.quota()?.remaining === 500, `got ${JSON.stringify(timing.quota())}`);
});

broken = true;
clock += 5 * 60 * 1000;
await timing.refresh();
check('a blip five minutes long keeps the last figure', () => {
  assert(timing.quota()?.remaining === 500, `got ${JSON.stringify(timing.quota())}`);
});

clock += 20 * 60 * 1000;
await timing.refresh();
check('a failure past the stale bound drops it instead of lying', () => {
  assert(timing.quota() === undefined, `still claiming ${JSON.stringify(timing.quota())}`);
});

broken = false;
liveValue = 12;
await timing.refresh();
check('and a recovered reader publishes again', () => {
  assert(timing.quota()?.remaining === 12, `got ${JSON.stringify(timing.quota())}`);
});

console.log('');
if (failures > 0) {
  console.log(`# catalog-refresh: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# catalog-refresh: OK');
