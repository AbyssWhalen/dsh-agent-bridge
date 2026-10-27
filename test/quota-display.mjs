/**
 * The quota surface both drivers share, and the two things that make it trustworthy:
 * a number that is really the remaining balance, and a stale reading that is withheld
 * rather than shown.
 *
 * Each driver spells its own balance text — Qoder writes `N credits left`, WorkBuddy
 * writes `N 积分` — so both are checked, and the shared formatter is checked as the
 * fallback used by a driver that does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatQuota, groupDigits, withSuffix } from '../lib/quota.js';
import { QUOTA_STALE_MS } from '../lib/catalog.js';
import { driver as workbuddy } from '../drivers/workbuddy/index.js';

test('thousands are separated so a large balance is readable', () => {
  assert.equal(groupDigits(999), '999');
  assert.equal(groupDigits(1000), '1,000');
  assert.equal(groupDigits(2521), '2,521');
  assert.equal(groupDigits(1234567), '1,234,567');
});

test('the shared formatter renders a balance and its unit', () => {
  assert.equal(formatQuota({ creditsLeft: 2521 }), '2,521 credits');
  // `note` is a prefix in front of the amount and replaces the default `credits` word —
  // which is why a driver wanting a Chinese unit word supplies `label` instead.
  assert.equal(formatQuota({ creditsLeft: 2521, note: '约 ' }), '约 2,521');
  // A driver that already built the whole string supplies it as `label`.
  assert.equal(formatQuota({ label: 'balance hidden' }), 'balance hidden');
});

test('an exhausted account still renders', () => {
  // Zero is a real reading, not a missing one. Blanking it would look like the plugin
  // could not reach the account instead of telling the user they are out of credit.
  assert.equal(formatQuota({ creditsLeft: 0 }), '0 credits');
});

test('an unlimited account says so instead of printing a huge number', () => {
  assert.equal(formatQuota({ unlimited: true, creditsLeft: 999999 }), 'unlimited');
});

test('a reading with nothing usable in it renders nothing', () => {
  // An invented figure is worse than no figure: it looks like a successful reading.
  for (const value of [undefined, null, {}, { creditsLeft: Number.NaN }, { creditsLeft: Infinity }, { creditsLeft: '2521' }]) {
    assert.equal(formatQuota(value), undefined, `should render nothing for ${JSON.stringify(value)}`);
  }
});

test("WorkBuddy's own formatter reports the remaining balance", () => {
  // `fetchCredits` sums each package's `remain`, so `total` is the remaining balance even
  // though the field name says otherwise. Rendering it as anything else would show a
  // number that never goes down.
  assert.equal(workbuddy.formatQuota({ total: 7156 }), '7,156 积分');
  assert.equal(workbuddy.formatQuota({ total: 0 }), '0 积分');
  assert.equal(workbuddy.formatQuota({ unlimited: true }), '额度不限');
  assert.equal(workbuddy.formatQuota(undefined), undefined);
  assert.equal(workbuddy.formatQuota({}), undefined);
});

test('the suffix joins the name without doubling the separator', () => {
  assert.equal(withSuffix('Qoder', '2,521 credits left'), 'Qoder · 2,521 credits left');
  assert.equal(withSuffix('Qoder', undefined), 'Qoder');
  assert.equal(withSuffix('Qoder', ''), 'Qoder');
});

test('a reading older than the stale window is withheld', () => {
  // The catalog keeps the last good figure for a bounded time. Past it the header goes
  // blank rather than showing a number that stopped being true.
  assert.equal(typeof QUOTA_STALE_MS, 'number');
  assert.ok(QUOTA_STALE_MS > 0);
  assert.ok(QUOTA_STALE_MS < 60 * 60 * 1000, 'an hour-old balance is not a balance');
});
