/**
 * WorkBuddy credential discovery.
 *
 * WorkBuddy (the CN desktop client) keeps its sign-in in a plain JSON file under
 * `CodeBuddyExtension`, next to — but distinct from — its AI sibling's file. This
 * module reads that file and nothing else: it never writes the app's own file,
 * because a proxy that rewrites the credential the desktop app is using would
 * eventually log the user out of the app.
 *
 * Two on-disk shapes exist and both are accepted: the nested OAuth form
 * (`{auth: {...}, account: {...}}`) that the plugin-style flows write, and the
 * flat form the app's own panel writes. Which one is present says nothing about
 * validity — only whether an access token came back does.
 *
 * Since WorkBuddy 5.6 the two token fields are sealed at rest; see `seal.js` for
 * how they are opened and why the app's own binary has to be involved.
 *
 * ## Refreshing
 *
 * A token inside its refresh margin is refreshed in memory through the upstream's
 * refresh endpoint, and the refreshed credential lives for the life of the
 * process. Nothing is persisted: a refresh is one request, and carrying a second
 * copy of a live token on disk is a cost with no matching benefit here.
 *
 * @module dsh-agent-bridge/drivers/workbuddy/auth
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { KeyProvider, openAuthDocument } from './seal.js';

/** Current format of the app's credential document. */
export const AUTH_FORMAT_VERSION = 1;

/** How long before expiry a token is refreshed. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** The shared directory both WorkBuddy apps write their credentials into. */
const AUTH_DIRECTORY = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];

/** The variant descriptor this driver serves. */
export const VARIANT = Object.freeze({
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  region: 'cn',
  /** Environment variable that overrides the credential location. */
  env: 'WORKBUDDY_AUTH_FILE',
  /** Basename of the desktop app's credential file. */
  desktopFilename: 'workbuddy-desktop.info'
});

/**
 * Trimmed non-empty text, or `undefined`.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Normalize an expiry that may arrive in seconds or milliseconds.
 *
 * @param {number} value
 * @returns {number}
 */
function expiryToMs(value) {
  if (!(typeof value === 'number') || value <= 0) return 0;
  return value > 0xe8d4a51000 ? value : value * 1000;
}

/**
 * The credential location the desktop app uses, in probe order.
 *
 * The app has moved between the two Windows `AppData` roots across builds, and a
 * signed-in app that reads as signed out is the worst failure this module can
 * produce — so both are probed rather than the current one being assumed.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function credentialCandidates(env = process.env) {
  const override = env[VARIANT.env];
  if (typeof override === 'string' && override.trim().length > 0) return [override.trim()];
  const home = env['USERPROFILE'] ?? env['HOME'] ?? homedir();
  return [
    join(home, 'AppData', 'Local', ...AUTH_DIRECTORY, VARIANT.desktopFilename),
    join(home, 'AppData', 'Roaming', ...AUTH_DIRECTORY, VARIANT.desktopFilename)
  ];
}

/**
 * The first candidate that exists, or the primary one.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function credentialPath(env = process.env) {
  const candidates = credentialCandidates(env);
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Absent is the expected case for the second candidate.
    }
  }
  return candidates[0];
}

/**
 * Parse a credential document in either on-disk shape.
 *
 * @param {string} text
 * @returns {object | undefined} `undefined` when no access token is present.
 */
export function parseCredential(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined;

  const nested = typeof document.auth === 'object' && document.auth !== null;
  const auth = nested ? document.auth : document;
  const identity = nested && typeof document.account === 'object' && document.account !== null ? document.account : document;

  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : '';
  if (accessToken === '') return undefined;

  const refreshExpiresAtMs = typeof auth.refreshExpiresAt === 'number' ? expiryToMs(auth.refreshExpiresAt) : undefined;
  const enterpriseId = optionalString(identity.enterpriseId);
  const nickname = optionalString(identity.nickname);
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: typeof auth.expiresAt === 'number' ? expiryToMs(auth.expiresAt) : 0,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(identity.uid) ?? '',
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname })
  };
}

/**
 * Read the desktop app's credential.
 *
 * Both the plaintext and the 5.6 sealed form are handled; the sealing is opened
 * lazily, so a plaintext file never spawns anything.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {KeyProvider} [provider]
 * @returns {Promise<{credential: object, path: string} | undefined>}
 */
export async function readCredential(env = process.env, provider) {
  const keys = provider ?? new KeyProvider({ env });
  for (const candidate of credentialCandidates(env)) {
    let text;
    try {
      text = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    let plaintext = text;
    // A sealed document throws here rather than reading as signed out: a WorkBuddy
    // install whose key cannot be resolved is a finding worth surfacing, and
    // "not signed in" would send the user to a sign-in screen that cannot help.
    plaintext = await openAuthDocument(text, keys);
    const credential = parseCredential(plaintext);
    if (credential !== undefined) return { credential, path: candidate };
  }
  return undefined;
}

/**
 * Whether the app has stored a usable credential.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {KeyProvider} [provider]
 * @returns {Promise<boolean>}
 */
export async function signedIn(env = process.env, provider) {
  return (await readCredential(env, provider)) !== undefined;
}

/** Directory holding the credential file, for logs. */
export function credentialDirectory(env = process.env) {
  return dirname(credentialPath(env));
}

/**
 * A read-only credential source with in-memory refresh.
 *
 * The refresh is demand-driven rather than scheduled: a token is refreshed on the
 * call that needs it, and a failed refresh returns the still-valid token instead
 * of failing the call. An unreachable refresh endpoint must not take down a
 * working session.
 */
export class CredentialSource {
  #refresh;
  #marginMs;
  #env;
  #logger;
  #keys;
  #current;
  #inflight;

  /**
   * @param {object} options
   * @param {(credential: object) => Promise<{accessToken: string, refreshToken?: string, expiresInSec?: number, domain?: string}>} options.refresh
   * @param {number} [options.marginMs]
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {KeyProvider} [options.keys]
   * @param {{debug?: Function, warn?: Function}} [options.logger]
   */
  constructor(options) {
    this.#refresh = options.refresh;
    this.#marginMs = options.marginMs ?? REFRESH_MARGIN_MS;
    this.#env = options.env ?? process.env;
    this.#keys = options.keys ?? new KeyProvider({ env: this.#env });
    this.#logger = options.logger;
  }

  /** The at-rest key state, for diagnostics. */
  get keys() {
    return this.#keys;
  }

  /** The credential to use for the next call. */
  async resolve() {
    const stored = await readCredential(this.#env, this.#keys);
    if (stored === undefined) {
      throw new Error(
        `workbuddy: not signed in — no usable credential at ${credentialCandidates(this.#env).join(' or ')}`
      );
    }
    const credential = { ...stored.credential };
    const expired = credential.expiresAtMs > 0 && credential.expiresAtMs - Date.now() <= this.#marginMs;
    if (!expired) return credential;

    if (credential.refreshToken === '') {
      this.#logger?.debug?.('workbuddy: the access token is expiring and no refresh token is stored');
      return credential;
    }
    const refreshed = await this.#refreshOnce(credential);
    return refreshed ?? credential;
  }

  /** Refresh at most once at a time. */
  async #refreshOnce(credential) {
    if (this.#inflight !== undefined) return this.#inflight;
    const attempt = (async () => {
      try {
        const outcome = await this.#refresh(credential);
        const merged = {
          ...credential,
          accessToken: outcome.accessToken,
          ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
          ...(outcome.domain === undefined ? {} : { domain: outcome.domain }),
          expiresAtMs:
            typeof outcome.expiresInSec === 'number' && outcome.expiresInSec > 0
              ? Date.now() + outcome.expiresInSec * 1000
              : credential.expiresAtMs
        };
        this.#current = merged;
        this.#logger?.debug?.('workbuddy: refreshed the access token');
        return merged;
      } catch (error) {
        // A refresh failure is not a session failure: the old token may still
        // work, and the next call will try again.
        this.#logger?.warn?.(`workbuddy: token refresh failed: ${String(error)}`);
        return undefined;
      }
    })();
    this.#inflight = attempt;
    try {
      return await attempt;
    } finally {
      this.#inflight = undefined;
    }
  }

  /** The last credential produced by a refresh, if any. */
  get lastRefreshed() {
    return this.#current;
  }
}
