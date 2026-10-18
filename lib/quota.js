/**
 * Quota display, shared by every driver.
 *
 * ## Where a quota can actually be shown
 *
 * The host-only surface for extra text is narrow, and it was measured rather than
 * assumed. `dsh-client-ui-model-selection`'s picker renders `group.name` as the
 * provider header, exactly once per group (`label: group.id === "deepseek-account"
 * ? t("provider.account") : group.name`), and `model.name` for each entry inside
 * it. `model.description` is not read there at all, and `LlmProviderInfo` carries
 * no other field.
 *
 * So an account-level balance belongs on the **group** header — one line, no
 * repetition — while a per-model rate belongs on the model's own name. Putting the
 * account balance on every model would repeat the same figure across nineteen
 * rows, which is noise rather than information.
 *
 * A missing quota is never an error and never produces a placeholder: a vendor
 * that cannot report a balance, or an account whose balance call just failed,
 * simply shows no suffix. Quota is decoration; a model list without it is still
 * usable, and an invented figure would be worse than none.
 *
 * @module dsh-agent-bridge/quota
 */

/** Separator between a name and a folded quota suffix. */
export const QUOTA_SEPARATOR = ' · ';

/**
 * Group a credit count for reading: `3401` becomes `3,401`.
 *
 * @param {number} value
 * @returns {string}
 */
export function groupDigits(value) {
  const rounded = Math.trunc(value);
  const text = String(Math.abs(rounded));
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && (text.length - index) % 3 === 0) out += ',';
    out += text[index];
  }
  return rounded < 0 ? `-${out}` : out;
}

/**
 * Human-readable text for one quota reading, or `undefined` when there is
 * nothing worth showing.
 *
 * @param {{creditsLeft?: number, unlimited?: boolean, resetAt?: string, label?: string, note?: string} | undefined} quota
 * @returns {string | undefined}
 */
export function formatQuota(quota) {
  if (quota === null || typeof quota !== 'object') return undefined;
  if (typeof quota.label === 'string' && quota.label.length > 0) return quota.label;
  if (quota.unlimited === true) return 'unlimited';
  if (typeof quota.creditsLeft !== 'number' || !Number.isFinite(quota.creditsLeft)) return undefined;
  const amount = groupDigits(quota.creditsLeft);
  const note = typeof quota.note === 'string' && quota.note.length > 0 ? quota.note : undefined;
  if (note !== undefined) return `${note}${amount}`;
  return `${amount} credits`;
}

/**
 * Fold a billing suffix into one model's display name.
 *
 * @param {string} name - the model's own display name.
 * @param {string | undefined} suffix - the quota or billing text, if any.
 * @returns {string}
 */
export function withSuffix(name, suffix) {
  if (typeof suffix !== 'string' || suffix.length === 0) return name;
  return `${name}${QUOTA_SEPARATOR}${suffix}`;
}
