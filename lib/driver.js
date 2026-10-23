/**
 * The contract a driver implements, and the one place that checks it.
 *
 * A driver is the only part of this plugin that can be broken by something
 * outside this repository: a desktop app updating, an endpoint moving, a token
 * format changing. So it is kept as small as possible, and as free of DSH as
 * possible — a driver imports `node:` and its siblings, nothing else.
 *
 * ```js
 * export const driver = {
 *   id: 'qoder',
 *   displayName: 'Qoder',
 *
 *   // Where the desktop app is, what version, whether anyone is signed in.
 *   // Must be able to describe "not installed" and "signed out" without throwing.
 *   locate(): Promise<{ installed: boolean, version?: string, root?: string, signedIn?: boolean }>,
 *
 *   // The account's models, in the shared catalog row shape.
 *   listModels(): Promise<RawModel[]>,
 *
 *   // One raw descriptor → one shared catalog row, or undefined when unusable.
 *   // Separate from listModels because normalization is also what a future
 *   // non-DSH shell would need, and it is the only pure function in the contract.
 *   normalize(raw: RawModel): CatalogRow | undefined,
 *
 *   // One open conversation.
 *   openSession({ key, logger }): Promise<{
 *     send(messages: BridgeMessage[], options: SendOptions): AsyncIterable<StreamChunk>,
 *     close(): Promise<void>,
 *   }>,
 *
 *   // Optional capabilities. A vendor that has none simply omits the member; the
 *   // host then never offers the control, which is the whole degradation policy.
 *   quota?(): Promise<QuotaFacts | undefined>,
 *   formatQuota?(quota: QuotaFacts): string | undefined,
 *   efforts?(row: RawModel): { values: string[], default?: string } | undefined,
 *   context?(row: RawModel): { window: number } | undefined,
 *
 *   // Optional flag, not a capability: `true` when this vendor's upstream supplies
 *   // its own agent system prompt, so the host withholds its proxy preamble rather
 *   // than letting the two contradict each other. See `adapter.js` for the
 *   // measurement behind it.
 *   ownSystemPrompt?: boolean,
 * };
 * ```
 *
 * `BridgeMessage` is `{ role: 'user' | 'assistant' | 'system' | 'tool', text: string }`
 * — already projected, so no driver has to understand a content-block array.
 *
 * `StreamChunk` is the harness's own union: `block-start`, `text-delta`,
 * `reasoning-delta`, `tool-call-delta`, `block-end`, `usage`, `finish`. A driver
 * emits it directly; there is no intermediate representation to translate
 * through.
 *
 * @module dsh-agent-bridge/driver
 */

/** Required text members: the route identity. */
const REQUIRED_TEXT = ['id', 'displayName'];

/** Required callable members, in the order the host calls them. */
const REQUIRED_FUNCTION = ['locate', 'listModels', 'normalize', 'openSession'];

/** Optional members, and the capability each one unlocks. */
const OPTIONAL = ['quota', 'formatQuota', 'efforts', 'context'];

/** Optional flags that change framing rather than adding a capability. */
const OPTIONAL_FLAG = ['ownSystemPrompt'];

/**
 * Check one driver against the contract without running it.
 *
 * Loading a driver is done inside a `try` by the host, because a driver is the
 * part most likely to be broken by an app update: a syntax error or a missing
 * member must degrade one vendor, never the plugin. This reports what is wrong
 * so the host can say so in a warning instead of failing mute.
 *
 * The text members and the callable members are checked separately. `id` and
 * `displayName` are data, and demanding a function for them rejects every valid
 * driver — which is exactly how this check failed the first time it met a real
 * driver set.
 *
 * @param {unknown} candidate
 * @returns {{ok: true, driver: object} | {ok: false, reason: string}}
 */
export function validateDriver(candidate) {
  if (candidate === null || typeof candidate !== 'object') return { ok: false, reason: 'no driver object was exported' };
  for (const member of REQUIRED_TEXT) {
    const value = candidate[member];
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, reason: `missing the required member "${member}"` };
    }
  }
  for (const member of REQUIRED_FUNCTION) {
    if (typeof candidate[member] !== 'function') {
      return { ok: false, reason: `missing the required member "${member}()"` };
    }
  }
  for (const member of OPTIONAL) {
    const value = candidate[member];
    if (value !== undefined && typeof value !== 'function') {
      return { ok: false, reason: `"${member}" is present but is not a function` };
    }
  }
  for (const member of OPTIONAL_FLAG) {
    const value = candidate[member];
    if (value !== undefined && typeof value !== 'boolean') {
      return { ok: false, reason: `"${member}" is present but is not a boolean` };
    }
  }
  return { ok: true, driver: candidate };
}

/**
 * Seed one shared catalog row from a driver's raw model shape.
 *
 * The shared shape is what the adapter and the catalogs both read, so the field
 * names are fixed here rather than per driver:
 *
 * - `id`, `name` — required; a row without either is dropped by the caller.
 * - `description` — optional picker subtitle.
 * - `contextWindow`, `maxTokens` — the two numbers the harness needs to accept a
 *   turn at all. A **positive integer** or nothing: `0`, negatives and fractions are
 *   dropped rather than forwarded, because the harness throws `INVALID_MODEL_CONTEXT`
 *   on them and that removes the model instead of degrading it. An absent number is
 *   safe — the harness applies its own default.
 * - `reasoning`, `efforts`, `defaultEffort`, `canDisableThinking` — the reasoning
 *   capability, all optional, all absent for a model with no control.
 *
 * @param {object} source
 * @returns {Record<string, unknown> | undefined} `undefined` when unusable.
 */
export function toCatalogRow(source) {
  if (source === null || typeof source !== 'object') return undefined;
  const id = typeof source.id === 'string' ? source.id : undefined;
  if (id === undefined || id.length === 0) return undefined;
  const name = typeof source.name === 'string' && source.name.length > 0 ? source.name : id;
  const contextWindow = positiveInteger(source.contextWindow);
  const maxTokens = positiveInteger(source.maxTokens);
  return {
    id,
    name,
    ...(typeof source.description === 'string' && source.description.length > 0 ? { description: source.description } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(source.reasoning === true ? { reasoning: true } : {}),
    ...(Array.isArray(source.efforts) ? { efforts: source.efforts.filter((value) => typeof value === 'string') } : {}),
    ...(typeof source.defaultEffort === 'string' ? { defaultEffort: source.defaultEffort } : {}),
    ...(source.canDisableThinking === true ? { canDisableThinking: true } : {})
  };
}

/**
 * The two model numbers, reduced to the shape the harness will accept.
 *
 * `normalizeModelInfo` rejects anything that is not a positive integer — it throws
 * `INVALID_MODEL_CONTEXT`, which removes the model rather than degrading it. So `0`, a
 * negative number and a fraction all have to become `undefined` here: an absent number
 * leaves the harness on its own default, while a malformed one costs the model.
 *
 * `Number.isFinite` was the earlier guard, and it passed all three of those through. Both
 * drivers happened to sanitize first, which is exactly why it went unnoticed — a new driver
 * reading this file as the contract would not have. `Math.trunc` is deliberately not used:
 * quietly repairing `1.5` to `1` would publish a number the upstream never stated.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveInteger(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}
