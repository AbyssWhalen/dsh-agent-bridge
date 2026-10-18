/**
 * Qoder's catalog row, normalized into the shared shape.
 *
 * The runtime reports far more than this; only the facts that change how a model
 * is presented, priced, or driven are kept. Field names differ from the shared
 * shape on purpose — nothing about an upstream's own JSON should leak past this
 * function.
 *
 * @module dsh-agent-bridge/drivers/qoder/models
 */

/** The context window assumed when the runtime declines to state one. */
const FALLBACK_CONTEXT = 200_000;

/** The output ceiling assumed when the runtime declines to state one. */
const FALLBACK_MAX_TOKENS = 32_000;

/** A positive finite number, or the fallback. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The thinking capability one runtime row declares.
 *
 * `thinking_config` is the authority, not the flat `efforts`/`isReasoning`
 * fields: the runtime leaves `isReasoning` off for some models that do carry an
 * effort list (DeepSeek-Flash, Kimi-K3), so reading the flat flags alone silently
 * drops their control. The config has two shapes:
 *
 * - `{ disabled, enabled }` — thinking can be turned off; `enabled.efforts`
 *   carries the levels when the model has them, and is absent for a plain
 *   on/off model such as Qwen3.7-Plus.
 * - `{ enabled }` — thinking is always on and only the levels are selectable.
 *
 * A row with no config and no flat capability has no control at all; offering
 * one would be a menu the runtime ignores.
 *
 * @param {any} raw
 * @returns {{efforts: string[], defaultEffort?: string, canDisable: boolean} | undefined}
 */
function thinkingFor(raw) {
  const flatEfforts = Array.isArray(raw?.efforts)
    ? raw.efforts.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [];
  const flatDefault =
    typeof raw?.defaultEffort === 'string' && flatEfforts.includes(raw.defaultEffort) ? raw.defaultEffort : undefined;
  const flatCanDisable = raw?.supportsDisabled === true;

  const config = raw?.thinking_config;
  if (config === null || typeof config !== 'object') {
    if (flatEfforts.length === 0 && !flatCanDisable) return undefined;
    return {
      efforts: flatEfforts,
      ...(flatDefault === undefined ? {} : { defaultEffort: flatDefault }),
      canDisable: flatCanDisable
    };
  }

  const enabled = config.enabled !== null && typeof config.enabled === 'object' ? config.enabled : undefined;
  const declared = enabled?.efforts !== null && typeof enabled?.efforts === 'object' ? Object.keys(enabled.efforts) : [];
  const efforts = declared.filter((entry) => typeof entry === 'string' && entry.length > 0);
  const fromConfig = efforts.find((id) => enabled.efforts[id]?.is_default === true);
  const canDisable = config.disabled !== undefined || flatCanDisable;
  const levels = efforts.length > 0 ? efforts : flatEfforts;
  const defaultEffort = fromConfig ?? (flatDefault !== undefined && levels.includes(flatDefault) ? flatDefault : undefined);

  if (levels.length === 0 && !canDisable) return undefined;
  return {
    efforts: levels,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    canDisable
  };
}

/**
 * Normalize one runtime model row.
 *
 * ## Two decisions worth stating
 *
 * **Thinking comes from `thinking_config`, not from `isReasoning`.** The runtime
 * marks a few models `isReasoning: false` while still giving them an effort list
 * (`DeepSeek-Flash`, `Kimi-K3`), and marks others `isReasoning: true` with no
 * control at all (`Auto`, `Qwen3.7-Flash`). Reading the flat flag alone therefore
 * both drops real controls and invents fake ones; `thinkingFor` reads the config
 * and the flat fields only as a fallback. An empty level list is not emitted: a
 * model with no levels and no off switch would otherwise get a one-option menu,
 * while the on/off-only shape is carried by `canDisableThinking` and becomes a
 * Default/Off pair.
 *
 * **Vision is not propagated.** A `isVl` model can accept images, but this bridge
 * declares text-only input for every vendor (see the adapter), and the harness
 * then strips image content instead of sending something the upstream rejects. A
 * vision model reached through this plugin is a text model; that is a deliberate
 * limitation, not an oversight.
 *
 * @param {unknown} raw
 * @returns {object | undefined} `undefined` for a row with no usable id.
 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object') return undefined;
  const id = raw.modelId ?? raw.value;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const thinking = thinkingFor(raw);
  return {
    id,
    name: typeof raw.displayName === 'string' && raw.displayName.length > 0 ? raw.displayName : id,
    ...(typeof raw.description === 'string' && raw.description.length > 0 ? { description: raw.description } : {}),
    reasoning: thinking !== undefined,
    ...(thinking === undefined || thinking.efforts.length === 0 ? {} : { efforts: thinking.efforts }),
    ...(thinking?.defaultEffort === undefined ? {} : { defaultEffort: thinking.defaultEffort }),
    ...(thinking?.canDisable === true ? { canDisableThinking: true } : {}),
    contextWindow: positive(raw.defaultContextWindow, positive(raw.maxInputTokens, FALLBACK_CONTEXT)),
    maxTokens: positive(raw.maxOutputTokens, FALLBACK_MAX_TOKENS)
  };
}
