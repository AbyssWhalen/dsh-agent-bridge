/**
 * Reasoning-effort normalization, shared by every driver.
 *
 * Effort control is an **optional capability**, and the rule is the same for
 * every vendor: a model the upstream does not describe gets no control at all,
 * and the field is then never sent. That is why this module's central outcome
 * is `undefined` rather than an empty list — `undefined` means "say nothing
 * about effort", and only the adapter knows how to honour it.
 *
 * The ordered sources are deliberate:
 *
 * 1. **What the model declared.** A non-empty `efforts` array on the catalog row
 *    is upstream truth and always wins, exactly as it stands.
 * 2. **What the driver declared.** A driver may derive a set from something the
 *    row does not carry (a worker listing, a static table). It is consulted
 *    only when the row said nothing.
 * 3. **Nothing.** No control, upstream default.
 *
 * `off` is special-cased because disabling thinking is a separate capability:
 * it is offered only when the model declares `canDisableThinking`, and never
 * inferred from an efforts list.
 *
 * @module dsh-agent-bridge/effort
 */

/** Canonical ordering of the effort levels the harness knows. */
export const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Display names for the canonical levels; an unknown id shows as itself. */
export const EFFORT_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
};

/**
 * Whether a value is a usable effort id.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function usable(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Order a set of effort ids canonically, keeping unknown ids at the end.
 *
 * The upstream's own ordering is not relied on: a picker that reorders itself
 * between two catalog refreshes is a defect, and a vendor that returns its
 * levels newest-first would produce one.
 *
 * @param {readonly string[]} ids
 * @returns {string[]}
 */
export function orderEfforts(ids) {
  const seen = new Set();
  const known = [];
  const unknown = [];
  for (const id of ids) {
    if (!usable(id) || seen.has(id)) continue;
    seen.add(id);
    (EFFORT_ORDER.includes(id) ? known : unknown).push(id);
  }
  known.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return [...known, ...unknown];
}

/**
 * Build the harness's reasoning descriptor for one model.
 *
 * @param {object} model - a normalized catalog row.
 * @param {{values: readonly string[], default?: string} | undefined} declaredByDriver
 *   the driver's own answer, consulted only when the row declares nothing.
 * @returns {{efforts: {id: string, name: string}[], defaultEffort?: string} | undefined}
 *   `undefined` when the vendor or the model offers no control — the adapter
 *   must then send no effort field rather than an empty one.
 */
export function buildReasoning(model, declaredByDriver) {
  if (model === null || typeof model !== 'object') return undefined;
  if (model.reasoning !== true) return undefined;

  const fromRow = Array.isArray(model.efforts) ? model.efforts.filter(usable) : [];
  const fromDriver =
    fromRow.length === 0 && declaredByDriver !== undefined && Array.isArray(declaredByDriver.values)
      ? declaredByDriver.values.filter(usable)
      : [];

  const ids = orderEfforts(fromRow.length > 0 ? fromRow : fromDriver);
  const offersOff = model.canDisableThinking === true;
  const withOff = offersOff && !ids.includes('off') ? ['off', ...ids] : ids;
  if (withOff.length === 0) return undefined;

  const defaultFromRow = usable(model.defaultEffort) ? model.defaultEffort : undefined;
  const defaultFromDriver =
    declaredByDriver !== undefined && usable(declaredByDriver.default) ? declaredByDriver.default : undefined;
  const candidate = defaultFromRow ?? defaultFromDriver;

  return {
    efforts: withOff.map((id) => ({ id, name: EFFORT_LABELS[id] ?? id })),
    // A default outside the offered set would be rejected by the resolver, so
    // it is dropped rather than clamped to something the user did not ask for.
    ...candidate !== undefined && withOff.includes(candidate) ? { defaultEffort: candidate } : {}
  };
}

/**
 * Translate the harness's validated effort id into what a driver should send.
 *
 * "No choice expressed" means *omit the field* — never send an empty string,
 * which some gateways read as an invalid level. `off` is a real choice and is
 * passed through: each driver encodes it in its own dialect. WorkBuddy drops the
 * field (absence is its default) while Qoder turns it into `--thinking disabled`.
 * Dropping `off` here would make the picker's "Off" option a no-op for the driver
 * that can actually honour it.
 *
 * @param {unknown} effort
 * @returns {string | undefined}
 */
export function wireEffort(effort) {
  if (!usable(effort)) return undefined;
  return String(effort);
}
