/**
 * Qoder's OpenAPI surfaces: job-token minting and account quota.
 *
 * Both are plain JSON over HTTPS and are the only two calls this plugin makes
 * itself. Model traffic does not go through here — it runs inside the app's
 * own worker runtime, which is the only client the model server accepts.
 *
 * @module dsh-agent-bridge/drivers/qoder/upstream
 */
import { AUTH_CLIENT_ID, OPENAPI_ORIGIN } from './locate.js';

/** Per-call ceiling for the control-plane requests. */
const REQUEST_TIMEOUT_MS = 20000;

/** Fetch with a deadline, so a hung control-plane call cannot stall a turn. */
async function fetchJson(url, init, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('qoder: request timed out')), REQUEST_TIMEOUT_MS);
  const relay = () => controller.abort(signal?.reason);
  if (signal !== undefined) {
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', relay);
  }
}

/** Parse a JSON body, reporting the upstream's own error text when it fails. */
function parseJson(result, what) {
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`qoder: ${what} returned a non-JSON body (http ${result.status}): ${result.text.slice(0, 200)}`);
  }
}

/** Upstream error text, when the service supplied one. */
function upstreamMessage(parsed, fallback) {
  const candidate = parsed?.errorMessage ?? parsed?.error_message ?? parsed?.message ?? parsed?.error ?? parsed?.msgInfo;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : fallback;
}

/**
 * Mint a job token from the device credential.
 *
 * A job token is the short-lived bearer the worker runtime accepts for model
 * traffic; the device token itself is not usable there. The desktop app mints
 * one through this same endpoint and hands it to the worker over the control
 * channel, which is exactly what {@link QoderSession} does.
 */
export async function mintJobToken(credential, options = {}) {
  const origin = options.origin ?? OPENAPI_ORIGIN;
  const clientId = options.clientId ?? AUTH_CLIENT_ID;
  const result = await fetchJson(
    `${origin}/api/v1/me/jobToken`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.token}`
      },
      body: JSON.stringify({ clientId })
    },
    options.signal
  );
  if (!result.ok) {
    const parsed = (() => {
      try {
        return JSON.parse(result.text);
      } catch {
        return undefined;
      }
    })();
    throw new Error(`qoder: job token request failed (http ${result.status}): ${upstreamMessage(parsed, result.text.slice(0, 200))}`);
  }
  const parsed = parseJson(result, 'job token request');
  const token = parsed?.token;
  if (typeof token !== 'string' || token.length === 0) throw new Error('qoder: job token response carried no token');
  return {
    token,
    refreshToken: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    expiresAt: typeof parsed.expires_at === 'string' ? parsed.expires_at : undefined
  };
}

/**
 * The account's remaining quota, normalized for display.
 *
 * Qoder reports two buckets: the plan's own quota (`userQuota`, zero on a
 * free plan) and purchased add-on credits (`addOnQuota`). Both are reported in
 * `credits`, so the remaining figure is their sum; `percentage` is the plan's
 * own utilization, which is what the app shows as the bar.
 *
 * @returns {Promise<{remaining: number, total: number, used: number, unit: string, percentage: number, exceeded: boolean, userType?: string, plan?: string}>}
 */
export async function fetchQuota(credential, options = {}) {
  const origin = options.origin ?? OPENAPI_ORIGIN;
  const result = await fetchJson(
    `${origin}/api/v2/quota/usage`,
    { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${credential.token}` } },
    options.signal
  );
  if (!result.ok) {
    const parsed = (() => {
      try {
        return JSON.parse(result.text);
      } catch {
        return undefined;
      }
    })();
    throw new Error(`qoder: quota request failed (http ${result.status}): ${upstreamMessage(parsed, result.text.slice(0, 200))}`);
  }
  const parsed = parseJson(result, 'quota request');
  const plan = parsed?.userQuota ?? {};
  const addOn = parsed?.addOnQuota ?? {};
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const remaining = number(plan.remaining) + number(addOn.remaining);
  const total = number(plan.total) + number(addOn.total);
  const used = number(plan.used) + number(addOn.used);
  return {
    remaining,
    total,
    used,
    unit: typeof addOn.unit === 'string' ? addOn.unit : typeof plan.unit === 'string' ? plan.unit : 'credits',
    percentage: number(parsed?.totalUsagePercentage),
    exceeded: parsed?.isQuotaExceeded === true,
    userType: typeof parsed?.userType === 'string' ? parsed.userType : undefined,
    ...typeof parsed?.plan === 'string' ? { plan: parsed.plan } : {}
  };
}

/**
 * A compact one-line quota string for the provider's group header.
 *
 * Deliberately terse: this is the whole quota surface a user sees without opening
 * anything, and it is rendered once per group rather than per model. Precision is
 * scaled to magnitude — credits are large, so sub-unit precision is noise, and a
 * thousands separator keeps `2599` from reading as a four-digit blur.
 *
 * @param {{remaining?: number, unit?: string, exceeded?: boolean} | undefined} quota
 * @returns {string | undefined}
 */
export function formatQuota(quota) {
  if (quota === undefined) return undefined;
  const value = quota.remaining;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const text = Number.isInteger(value)
    ? String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
    : value >= 100
      ? value.toFixed(0)
      : value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
  return quota.exceeded === true ? 'quota exhausted' : `${text} ${quota.unit ?? 'credits'} left`;
}
