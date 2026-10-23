/**
 * `toCatalogRow` is the last guard between a driver's raw descriptor and the harness.
 *
 * The harness is strict about the two numbers it is given: `normalizeModelInfo` throws
 * `INVALID_MODEL_CONTEXT` unless `contextWindow` is a positive integer, so a row carrying
 * `0`, a negative number, or a fraction does not degrade — it takes the whole model out.
 *
 * Both drivers already sanitize with their own `positive`/`size` helper, which is why this
 * has never been seen in the wild. That is precisely the reason to hold the line here: the
 * contract file is where a new driver looks for the rules, and today it documents a rule it
 * does not enforce. A driver written against this comment would ship the bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toCatalogRow } from '../lib/driver.js';

const row = (extra) => toCatalogRow({ id: 'm1', name: 'M1', ...extra });

test('a positive integer context window is kept', () => {
  assert.equal(row({ contextWindow: 200_000 }).contextWindow, 200_000);
  assert.equal(row({ maxTokens: 32_000 }).maxTokens, 32_000);
});

test('zero is dropped, not forwarded', () => {
  // `0` is the shape an upstream uses for "not stated". Forwarding it makes the harness
  // reject the model outright, which reads to the user as the model disappearing.
  assert.equal(row({ contextWindow: 0 }).contextWindow, undefined);
  assert.equal(row({ maxTokens: 0 }).maxTokens, undefined);
});

test('a negative number is dropped', () => {
  assert.equal(row({ contextWindow: -1 }).contextWindow, undefined);
  assert.equal(row({ maxTokens: -5 }).maxTokens, undefined);
});

test('a fraction is dropped', () => {
  assert.equal(row({ contextWindow: 1.5 }).contextWindow, undefined);
  assert.equal(row({ maxTokens: 0.5 }).maxTokens, undefined);
});

test('non-finite and non-numeric values are dropped', () => {
  for (const bad of [NaN, Infinity, -Infinity, '8192', null, undefined, {}, []]) {
    assert.equal(row({ contextWindow: bad }).contextWindow, undefined, `contextWindow ${String(bad)}`);
    assert.equal(row({ maxTokens: bad }).maxTokens, undefined, `maxTokens ${String(bad)}`);
  }
});

test('a row keeps the fields it can trust', () => {
  // Dropping a bad number must not cost the caller the rest of the row.
  const kept = row({ contextWindow: 0, description: 'd', reasoning: true });
  assert.equal(kept.id, 'm1');
  assert.equal(kept.name, 'M1');
  assert.equal(kept.description, 'd');
  assert.equal(kept.reasoning, true);
});
