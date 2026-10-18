/**
 * Turn WorkBuddy catalog rows into the bridge's catalog rows.
 *
 * The upstream already states most of what the harness needs, so this module is
 * mostly a rename. The one judgement it makes is the reasoning gate: WorkBuddy
 * declares a model's effort set explicitly, and a model that declares nothing gets
 * **no control at all** — never a guessed set and never a probe. Probing would mean
 * issuing a request the user did not ask for against a metered account, and the
 * upstream's declaration is authoritative anyway.
 *
 * `off` is offered only when the upstream says the model can be switched off, and
 * the CN endpoint vetoes it for a model declared `onlyReasoning`. That veto is
 * reproduced here rather than hidden in the transport: the picker must not offer a
 * level the request will be rejected for.
 *
 * @module dsh-agent-bridge/drivers/workbuddy/models
 */

/** Used when a row states no context window. */
const FALLBACK_CONTEXT_WINDOW = 200_000;

/** Used when a row states no output ceiling. */
const FALLBACK_MAX_TOKENS = 32_000;

/**
 * Trimmed non-empty text, or `undefined`.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * A positive integer, or the fallback.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function size(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * The reasoning capability for one row, or `undefined` when there is none.
 *
 * @param {object} raw
 * @param {'cn' | 'global'} region
 * @returns {{values: string[], default?: string, canDisable: boolean} | undefined}
 */
function reasoningFor(raw, region) {
  const declared = raw.reasoning;
  if (declared === null || typeof declared !== 'object') return undefined;
  if (declared.supports !== true) return undefined;

  const values = Array.isArray(declared.supportedEfforts)
    ? declared.supportedEfforts.filter((value) => typeof value === 'string' && value.length > 0)
    : [];
  if (values.length === 0) return undefined;

  const declaredDefault = text(declared.defaultEffort);
  // A model declared `onlyReasoning` cannot be switched off, and the CN endpoint
  // enforces that by rejecting the request rather than by ignoring the field.
  const canDisable = declared.canDisableThinking === true && !(region === 'cn' && declared.onlyReasoning === true);

  return {
    values,
    ...(declaredDefault === undefined ? {} : { default: declaredDefault }),
    canDisable
  };
}

/**
 * The billing text to fold into the display name.
 *
 * Preference order mirrors what the upstream itself renders: a live promotional
 * badge reads better than a multiplier, and a multiplier reads better than
 * nothing. A model the upstream marks free says so outright.
 *
 * @param {object} raw
 * @returns {string | undefined}
 */
export function billingLabel(raw) {
  const billing = raw.billing;
  if (billing === null || typeof billing !== 'object') return undefined;
  const badges = Array.isArray(billing.badges) ? billing.badges.filter((value) => typeof value === 'string') : [];
  const credits = text(billing.credits);
  const parts = [];
  if (billing.free === true) parts.push('免费');
  for (const badge of badges) if (!parts.includes(badge)) parts.push(badge);
  if (credits !== undefined) parts.push(credits);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * Normalize one upstream catalog row.
 *
 * The id is the upstream's own model id: unlike its vendors-in-one-app
 * competitors, WorkBuddy serves a single roster, so there is no second dimension
 * to disambiguate.
 *
 * The billing text is folded into `name` here rather than kept beside it. DSH's
 * picker renders `name` and nothing else about a model's price, so a rate or a
 * promotional badge only reaches the user by travelling inside the name.
 *
 * @param {object} raw
 * @param {{region?: 'cn' | 'global'}} [options]
 * @returns {import('../../lib/driver.js').CatalogRow | undefined}
 */
export function normalizeModel(raw, options = {}) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const id = text(raw.id);
  if (id === undefined) return undefined;
  const region = options.region ?? 'cn';

  const contextWindow = size(raw.contextWindow, FALLBACK_CONTEXT_WINDOW);
  const maxTokens = size(raw.maxTokens, FALLBACK_MAX_TOKENS);
  const reasoning = reasoningFor(raw, region);
  const base = text(raw.name) ?? id;
  const billing = billingLabel(raw);

  return {
    id,
    name: billing === undefined ? base : `${base} · ${billing}`,
    ...(text(raw.description) === undefined ? {} : { description: raw.description }),
    contextWindow,
    maxTokens,
    ...(reasoning === undefined
      ? {}
      : {
          reasoning: true,
          efforts: reasoning.values,
          ...(reasoning.default === undefined ? {} : { defaultEffort: reasoning.default }),
          ...(reasoning.canDisable ? { canDisableThinking: true } : {})
        })
  };
}
