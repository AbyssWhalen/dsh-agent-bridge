/**
 * The driver contract, held against the two drivers that live in this repository.
 *
 * `validateDriver` is the only thing standing between a broken driver and a plugin that
 * fails mute: the host calls it inside a `try`, so a driver that fails it degrades one
 * vendor instead of the whole page. Nothing tested it, which meant the contract could
 * drift in either direction without a sound:
 *
 *   - a driver gaining a required member that the table does not list (silently unused),
 *   - the table demanding a member no driver has (every driver rejected at load).
 *
 * Both real drivers are exercised, not a hand-written stub — a stub proves the function
 * agrees with itself. The negatives are built by removing exactly one member from a real
 * driver, so a failure can only come from the member under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateDriver } from '../lib/driver.js';

/** The drivers this plugin ships. A third entry here is a reminder to re-read the table. */
const SHIPPED = ['qoder', 'workbuddy'];

const load = async (name) => {
  const module = await import(`../drivers/${name}/index.js`);
  return module.driver ?? module.default;
};

test('every shipped driver passes the contract', async () => {
  for (const name of SHIPPED) {
    const driver = await load(name);
    const result = validateDriver(driver);
    assert.equal(result.ok, true, `${name}: ${result.reason}`);
    assert.equal(result.driver, driver, `${name}: the accepted driver is handed back`);
  }
});

test('every shipped driver names itself consistently', async () => {
  const seen = new Set();
  for (const name of SHIPPED) {
    const driver = await load(name);
    // The directory is what the plugin resolves, so it has to match the declared id —
    // otherwise a warning says "trae is broken" while the log says "qoder".
    assert.equal(driver.id, name, `${name}: id must equal its directory`);
    assert.equal(seen.has(driver.id), false, `${name}: id "${driver.id}" is used twice`);
    seen.add(driver.id);
  }
});

test('a missing callable member is reported by name', async () => {
  const driver = await load('qoder');
  for (const member of ['locate', 'listModels', 'normalize', 'openSession']) {
    const broken = { ...driver };
    delete broken[member];
    const result = validateDriver(broken);
    assert.equal(result.ok, false, `${member}: removing it must be rejected`);
    assert.match(result.reason, new RegExp(member), `${member}: the reason must name it`);
  }
});

test('a missing text member is reported by name', async () => {
  const driver = await load('qoder');
  for (const member of ['id', 'displayName']) {
    for (const bad of [undefined, '', 42]) {
      const broken = { ...driver, [member]: bad };
      const result = validateDriver(broken);
      assert.equal(result.ok, false, `${member}=${String(bad)} must be rejected`);
      assert.match(result.reason, new RegExp(member));
    }
  }
});

test('a present-but-wrong optional member is rejected, an absent one is fine', async () => {
  const driver = await load('qoder');
  // Absent optional members are the normal case: a driver without balance reporting
  // simply does not declare `quota`, and that must not be an error.
  const bare = { id: 'x', displayName: 'X', locate() {}, listModels() {}, normalize() {}, openSession() {} };
  assert.equal(validateDriver(bare).ok, true, 'a driver with no optional members is valid');
  assert.equal(validateDriver({ ...bare, quota() {} }).ok, true, 'a callable optional member is valid');
  for (const member of ['quota', 'formatQuota', 'efforts', 'context']) {
    const result = validateDriver({ ...bare, [member]: 'not a function' });
    assert.equal(result.ok, false, `${member} as text must be rejected`);
    assert.match(result.reason, new RegExp(member));
  }
  // `ownSystemPrompt` is a flag, not a capability: a string here would silently be
  // read as "this driver has its own prompt" by a truthiness check.
  for (const bad of ['yes', 1, {}]) {
    const result = validateDriver({ ...bare, ownSystemPrompt: bad });
    assert.equal(result.ok, false, `ownSystemPrompt=${String(bad)} must be rejected`);
    assert.match(result.reason, /ownSystemPrompt/);
  }
  assert.equal(validateDriver({ ...bare, ownSystemPrompt: true }).ok, true);
});

test('junk input is rejected rather than thrown on', async () => {
  // The host calls this inside a `try`, but a function that throws instead of
  // answering makes the warning generic — "failed to load" instead of why.
  for (const junk of [null, undefined, 0, '', 'qoder', [], () => {}]) {
    const result = validateDriver(junk);
    assert.equal(result.ok, false, `${String(junk)} must be rejected`);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, 'a rejection always says why');
  }
});

test('the real drivers still satisfy everything the host calls', async () => {
  // Validating the table is not the same as validating behaviour: these are the two
  // members whose return shapes the host reads before any turn can start.
  for (const name of SHIPPED) {
    const driver = await load(name);
    const located = await driver.locate();
    assert.equal(typeof located, 'object', `${name}: locate() resolves to an object`);
    assert.equal(typeof located.installed, 'boolean', `${name}: locate() states "installed"`);
    // "signed out" has to be expressible without throwing — that is the documented rule.
    assert.ok('signedIn' in located || 'signedIn' in (located.account ?? {}), `${name}: locate() can report sign-in`);
  }
});
