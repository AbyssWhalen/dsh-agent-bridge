/**
 * Offline verification of reasoning-effort normalization.
 *
 * The Qoder runtime describes thinking in `thinking_config`, and two of its rows
 * disagree with the flat `isReasoning` flag: DeepSeek-Flash and Kimi-K3 carry an
 * effort list while `isReasoning` is absent. Reading the flat flag alone dropped
 * their control, which is the bug this test pins. The same fixtures also prove
 * the on/off-only shape (Qwen3.7-Plus) and the no-control shape (Auto).
 *
 * Run with `node test/efforts.mjs`.
 */
import assert from 'node:assert/strict';
import { buildReasoning, wireEffort } from '../lib/effort.js';
import { normalizeModel } from '../drivers/qoder/models.js';
import { controlEffort } from '../drivers/qoder/session.js';
import { prepareChatBody } from '../drivers/workbuddy/upstream.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One Qoder raw row with only the fields normalization reads. */
function row(overrides) {
  return {
    modelId: 'm',
    displayName: 'M',
    maxInputTokens: 200_000,
    maxOutputTokens: 32_000,
    ...overrides
  };
}

/** The effort ids the picker will offer, in canonical order. */
function offered(raw) {
  const model = normalizeModel(raw);
  const reasoning = buildReasoning(model);
  return reasoning === undefined ? undefined : reasoning.efforts.map((entry) => entry.id);
}

console.log('# reasoning effort');

check('a model with levels and an off switch offers both', () => {
  const raw = row({
    modelId: 'qmodel_38max',
    isReasoning: true,
    thinking_config: {
      disabled: {},
      enabled: { efforts: { xhigh: {}, low: {}, medium: { is_default: true } }, is_default: true }
    }
  });
  assert.deepEqual(offered(raw), ['off', 'low', 'medium', 'xhigh']);
  assert.equal(buildReasoning(normalizeModel(raw)).defaultEffort, 'medium');
});

check('a model whose flat isReasoning flag is absent still gets its levels', () => {
  const raw = row({
    modelId: 'dfmodel',
    efforts: ['high', 'max', 'low'],
    defaultEffort: 'max',
    supportsDisabled: true,
    thinking_config: {
      disabled: { description: 'Disable thinking' },
      enabled: {
        is_default: true,
        efforts: { high: {}, max: { is_default: true }, low: {} }
      }
    }
  });
  assert.deepEqual(offered(raw), ['off', 'low', 'high', 'max']);
  assert.equal(buildReasoning(normalizeModel(raw)).defaultEffort, 'max');
});

check('a model that cannot disable thinking offers levels only', () => {
  const raw = row({
    modelId: 'kmodel_latest',
    efforts: ['high', 'low', 'max'],
    defaultEffort: 'max',
    thinking_config: {
      enabled: { is_default: true, efforts: { high: {}, low: {}, max: { is_default: true } } }
    }
  });
  assert.deepEqual(offered(raw), ['low', 'high', 'max']);
});

check('an on/off-only model offers exactly Off', () => {
  const raw = row({
    modelId: 'qmodel',
    isReasoning: true,
    supportsDisabled: true,
    thinking_config: {
      disabled: { description: 'Disable thinking' },
      enabled: { description: 'Enable thinking', is_default: true }
    }
  });
  assert.deepEqual(offered(raw), ['off']);
});

check('a model with no thinking config gets no control', () => {
  const raw = row({ modelId: 'auto', isReasoning: true });
  assert.equal(normalizeModel(raw).reasoning, false);
  assert.equal(offered(raw), undefined);
});

check('the flat fields remain a fallback for an older runtime', () => {
  const raw = row({ modelId: 'legacy', efforts: ['low', 'high'], defaultEffort: 'low' });
  assert.deepEqual(offered(raw), ['low', 'high']);
});

check('an unrecognised value is passed through, and no choice stays undefined', () => {
  assert.equal(wireEffort('off'), 'off');
  assert.equal(wireEffort('high'), 'high');
  assert.equal(wireEffort(undefined), undefined);
  assert.equal(wireEffort(''), undefined);
});

check('Qoder spells Off as none on its control channel', () => {
  assert.equal(controlEffort('off'), 'none');
  assert.equal(controlEffort('high'), 'high');
  assert.equal(controlEffort(undefined), undefined);
});

check('WorkBuddy drops Off before the wire but keeps a real level', () => {
  const off = prepareChatBody({ model: 'm', messages: [], reasoning_effort: 'off' }, 'cn');
  assert.equal('reasoning_effort' in off, false);
  const high = prepareChatBody({ model: 'm', messages: [], reasoning_effort: 'high' }, 'cn');
  assert.equal(high.reasoning_effort, 'high');
});

if (failures > 0) {
  console.log(`\n# ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n# efforts: OK');
