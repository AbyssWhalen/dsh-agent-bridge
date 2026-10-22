/**
 * The conversion every driver failure passes through on its way to the harness.
 *
 * Kept beside {@link KIND_TO_CODE} for the reason given there: the adapter is the only seam that
 * speaks both the drivers' vocabulary and the harness's.
 */
import { LlmError } from '@deepseek-ai/dsh-llm';
import { codeFor, kindOf } from './failure.js';

/**
 * Turn whatever a driver threw into an `LlmError` the harness can classify.
 *
 * Three rules, in order:
 *
 * 1. **Already an `LlmError`** — passed through. A driver is allowed to speak the harness's
 *    language directly, and wrapping it would only nest the same facts.
 * 2. **A kind we know** — mapped through {@link KIND_TO_CODE}, keeping the status code when the
 *    driver recorded one, so a reader still sees the 429 next to `RATE_LIMIT`.
 * 3. **Anything else** — `INTERNAL`, with the sentence and the status preserved. Guessing
 *    "transient" here would turn a deterministic bug into an endless retry loop, which is the
 *    one outcome worth being conservative about.
 *
 * The message is never rewritten. It is the driver's sentence, built from what the upstream
 * actually said, and it is the part a user reads.
 *
 * @param {unknown} error
 * @param {string} provider - the route id, for the message when the error has none.
 * @returns {LlmError}
 */
export function toLlmError(error, provider) {
  if (error instanceof LlmError) return error;

  const kind = kindOf(error);
  const code = codeFor(kind);
  const message =
    typeof error?.message === 'string' && error.message.length > 0
      ? error.message
      : `${provider}: the turn failed without saying why`;

  const status = statusOf(error);
  const options = {
    ...(status === undefined ? {} : { status }),
    ...(error instanceof Error ? { cause: error } : {})
  };

  // A cancellation is not a failure of the upstream, and the harness uses this flag — not the
  // code alone — to decide whether the turn was stopped or broken.
  if (code === 'ABORTED') {
    const aborted = new LlmError(message, code, options);
    aborted.name = 'AbortError';
    return aborted;
  }
  return new LlmError(message, code, options);
}

/**
 * The HTTP status a driver attached, if it attached a valid one.
 *
 * `LlmError` rejects anything outside 100–599, and a driver reports `0` for "never got a
 * response" — so an invalid value has to be dropped rather than passed through and thrown on.
 *
 * @param {unknown} error
 * @returns {number | undefined}
 */
function statusOf(error) {
  const status = /** @type {{status?: unknown}} */ (error)?.status;
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  return status >= 100 && status <= 599 ? status : undefined;
}
