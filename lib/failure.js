/**
 * The one place a driver's failure is turned into something the harness can still read.
 *
 * The harness keeps a failure's meaning only when the error it catches is an `LlmError`:
 *
 *     turnEnds = { kind: 'error', error: error instanceof LlmError ? error.failure : { message, code: 'UNKNOWN' } }
 *
 * — `dsh-agent-loop`, in the turn's `catch`. Everything else is recorded as `code: 'UNKNOWN'`
 * and the message is kept as prose. Two things are lost with it:
 *
 * 1. **Retry.** `dsh-llm-retry` only acts on `failure.code` in `retryableCodes`, which defaults
 *    to `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`. An unclassified
 *    failure is never retried, however transient it actually was.
 * 2. **Reading the record.** A 429, a dead session, a spent balance and a broken server all
 *    end up as the same word, so the session log cannot answer "what kept going wrong" after
 *    the fact.
 *
 * Measured before this file existed — a Qoder turn refused by the daily Chat limit, verbatim:
 *
 *     dsh: UNKNOWN: qoder: You've reached your daily usage limit for Chat. ...
 *
 * The words survived; the meaning did not.
 *
 * ## Why the mapping lives at the adapter, not in the drivers
 *
 * The drivers describe what happened in their own terms (`soft_rate`, `session_dead`, …) and
 * are deliberately free of harness types — they are also driven directly by tests and by
 * `tools/`, where importing `@deepseek-ai/dsh-llm` would be a weight nobody needs. The adapter
 * is the last thing that still knows both vocabularies, so it is the only correct seam. One
 * table then covers both drivers, which is exactly what the round-7 defects kept failing to do.
 */

/**
 * How this plugin's failure kinds map to the harness's provider-neutral codes.
 *
 * The right column is not free-form. `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` and
 * `EMPTY_RESPONSE` are what the default retry policy acts on; `QUOTA`, `INVALID_CREDENTIAL`,
 * `CONTEXT_WINDOW_EXCEEDED` and `ABORTED` are canonical codes the harness already knows how to
 * display. `NOT_FOUND` and `BAD_REQUEST` are this plugin's own, chosen to look like the rest —
 * neither is retryable, and calling them `SERVER` would make the harness retry a model name
 * that will never exist.
 */
export const KIND_TO_CODE = Object.freeze({
  /** 429 with a queue: the free tier is busy. Transient. */
  soft_rate: 'RATE_LIMIT',
  /** 5xx: the upstream is unwell. Transient. */
  server: 'SERVER',
  /** Transport-level failure, no response at all. Transient. */
  transport: 'TRANSPORT',
  /** A turn that ended cleanly having produced nothing. Transient, and the only one we caused. */
  empty_turn: 'EMPTY_RESPONSE',
  /** The balance is spent. Retrying cannot fix it. */
  hard_credit: 'QUOTA',
  /** The daily allowance is spent — distinct from credits, same outcome. */
  quota: 'QUOTA',
  /** Signed out, or the session token died. */
  session_dead: 'INVALID_CREDENTIAL',
  /** Unknown model, or an upstream that does not serve it. */
  not_found: 'NOT_FOUND',
  /** The request itself was wrong. */
  client: 'BAD_REQUEST',
  /** The caller stopped it. Never retried, never reported as an upstream fault. */
  cancelled: 'ABORTED'
});

/** The subset the harness will retry on its own; spelled out so a reader can check the claim. */
const RETRYABLE = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']);

/**
 * A turn that finished cleanly without producing anything.
 *
 * Marked rather than described. F-027 made this a failure instead of a blank answer, and this
 * is the other half: the harness retries `EMPTY_RESPONSE` by default, and nothing else about a
 * contentless turn is retryable. Left unmarked, the one recoverable case was the one that never
 * got recovered.
 *
 * @param {string} message
 * @returns {Error}
 */
export function emptyTurn(message) {
  const error = new Error(message);
  error.name = 'EmptyTurnError';
  error.bridgeKind = 'empty_turn';
  return error;
}

/**
 * A failure the upstream reported as prose rather than as a status code.
 *
 * Some upstreams answer a turn with a sentence instead of an error frame: "the model is busy",
 * "you've reached your daily usage limit". Those carry no HTTP status, so nothing downstream can
 * classify them — they arrive as ordinary text that happens to be a refusal. Marking the kind at
 * the point of recognition is what keeps that meaning from being lost on the way out; the live
 * symptom of not doing it was a Qoder allowance notice recorded as `dsh: INTERNAL: …`, which
 * reads exactly like a bug in this plugin.
 *
 * `name` is deliberately left as `Error`. This is not a cancellation and not a transport error;
 * the kind is the only thing worth asserting about it.
 *
 * @param {string} message
 * @param {string} kind
 * @returns {Error}
 */
export function noticedFailure(message, kind) {
  const error = new Error(message);
  error.bridgeKind = kind;
  return error;
}

/**
 * The kind a driver's error declares, if it declares one.
 *
 * `UpstreamFailure` carries `kind`; the drivers' own marked errors carry `bridgeKind`; an
 * `AbortError` is a cancellation by universal convention even when nothing set a field.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
export function kindOf(error) {
  if (error === null || typeof error !== 'object') return undefined;
  const record = /** @type {{kind?: unknown, bridgeKind?: unknown, name?: unknown}} */ (error);
  if (typeof record.bridgeKind === 'string' && record.bridgeKind.length > 0) return record.bridgeKind;
  if (typeof record.kind === 'string' && record.kind.length > 0) return record.kind;
  if (record.name === 'AbortError') return 'cancelled';
  return undefined;
}

/**
 * Whether the harness would retry this code on its own.
 *
 * Exported so a test can assert the claim instead of trusting the comment above.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function isRetryableCode(code) {
  return RETRYABLE.has(code);
}

/**
 * The code to report for a failure, given its kind.
 *
 * Unrecognised kinds resolve to `INTERNAL` rather than a retryable code: guessing "transient"
 * on behalf of an error nobody classified would turn a deterministic bug into an endless
 * retry loop.
 *
 * @param {string | undefined} kind
 * @returns {string}
 */
export function codeFor(kind) {
  if (kind === undefined) return 'INTERNAL';
  return KIND_TO_CODE[kind] ?? 'INTERNAL';
}
