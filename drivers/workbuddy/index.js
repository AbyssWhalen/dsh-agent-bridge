/**
 * The WorkBuddy driver.
 *
 * Serves the WorkBuddy CN desktop client's account over plain HTTP. Unlike the
 * other drivers here, there is no local process to manage: the credential is read
 * from the app's own file and every call is an ordinary request.
 *
 * ## Why it reads the app's file
 *
 * The plugin references took two different routes here — one re-runs the app's
 * sign-in, the other reads the stored credential. This driver reads: the app has
 * already signed the user in, and a second OAuth flow would ask for something the
 * user has already granted. The file is opened read-only, and a refresh is kept in
 * memory so the app's own copy is never rewritten.
 *
 * @module dsh-agent-bridge/drivers/workbuddy
 */
import { CredentialSource, readCredential, VARIANT } from './auth.js';
import { WorkBuddyConversation } from './conversation.js';
import { normalizeModel } from './models.js';
import { KeyProvider } from './seal.js';
import { UpstreamClient } from './upstream.js';

/** The route id this driver registers under. */
export const ID = VARIANT.id;

/** The name shown for this vendor's model group. */
export const DISPLAY_NAME = VARIANT.displayName;

/** How long a credit reading is reused before it is fetched again. */
export const CREDIT_TTL_MS = 60 * 1000;

/** Module-local memo of the last credit reading. */
let cachedCredits;

/** The shared upstream client. */
let client;

/** The shared at-rest key provider, so the app binary is spawned once. */
let keys;

/**
 * The at-rest key provider for this process.
 *
 * Shared deliberately: it caches the resolved key, and a second provider would run
 * the app's binary a second time for the same answer.
 *
 * @returns {KeyProvider}
 */
function keysFor() {
  if (keys === undefined) keys = new KeyProvider();
  return keys;
}

/**
 * The client for this process, created on first use.
 *
 * @param {{debug?: Function, warn?: Function}} [logger]
 * @returns {UpstreamClient}
 */
function clientFor(logger) {
  if (client === undefined) client = new UpstreamClient({ region: VARIANT.region, logger });
  return client;
}

/**
 * Build a credential source backed by the shared client.
 *
 * @param {{debug?: Function, warn?: Function}} [logger]
 * @returns {CredentialSource}
 */
function sourceFor(logger) {
  return new CredentialSource({
    refresh: (credential) => clientFor(logger).refreshToken(credential),
    keys: keysFor(),
    logger
  });
}

/**
 * The credential to use for the next call.
 *
 * @param {{debug?: Function, warn?: Function}} [logger]
 * @returns {Promise<object>}
 */
async function credentialFor(logger) {
  return sourceFor(logger).resolve();
}

/** Drop the memoized credit reading, so the next read is fresh. */
export function forgetCredits() {
  cachedCredits = undefined;
}

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

/** The driver implementation. */
export const driver = {
  id: ID,
  displayName: DISPLAY_NAME,

  /**
   * Report whether the desktop app has stored a credential.
   *
   * The sealed form has to be opened to answer this, which runs the app's binary
   * once; the resolved key is cached, so a status check the user repeats costs
   * nothing after the first.
   *
   * @returns {Promise<{installed: boolean, signedIn: boolean, reason?: string}>}
   */
  async locate() {
    let stored;
    try {
      stored = await readCredential(process.env, keysFor());
    } catch (error) {
      return {
        installed: true,
        signedIn: false,
        reason:
          `WorkBuddy's credential file is present but could not be read: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    if (stored === undefined) {
      return {
        installed: true,
        signedIn: false,
        reason: `WorkBuddy is not signed in — no usable credential file was found for ${VARIANT.desktopFilename}`
      };
    }
    return { installed: true, signedIn: true };
  },

  /**
   * List the models this account may use.
   *
   * @param {{logger?: object}} [options]
   * @returns {Promise<object[]>} raw upstream rows.
   */
  async listModels(options = {}) {
    const credential = await credentialFor(options.logger);
    return clientFor(options.logger).fetchModels(credential);
  },

  /** Normalize one upstream row into a catalog row. */
  normalize(raw) {
    return normalizeModel(raw, { region: VARIANT.region });
  },

  /**
   * Open a conversation.
   *
   * Trivial here: the vendor is stateless, so a conversation is a thin pair of
   * handles and opening one cannot fail on its own.
   *
   * @param {{logger?: object}} [options]
   * @returns {Promise<WorkBuddyConversation>}
   */
  async openSession(options = {}) {
    const logger = options.logger;
    return new WorkBuddyConversation({
      client: clientFor(logger),
      resolveCredential: () => credentialFor(logger),
      logger
    });
  },

  /**
   * Report the account's remaining credit.
   *
   * Memoized for a minute: the model picker asks for this on every render, and the
   * billing endpoint is a metered call on the user's own account.
   *
   * @param {{fresh?: boolean}} [options]
   * @returns {Promise<object | undefined>}
   */
  async quota(options = {}) {
    if (options.fresh !== true && cachedCredits !== undefined && Date.now() - cachedCredits.at < CREDIT_TTL_MS) {
      return cachedCredits.value;
    }
    // A failed read is a rejection, not an empty reading. The catalog keeps the
    // last good figure for a bounded time; flattening the failure to `undefined`
    // here would look like a successful "no balance" answer and blank the header
    // on a single failed poll.
    const credential = await credentialFor();
    const value = await clientFor().fetchCredits(credential);
    cachedCredits = { at: Date.now(), value };
    return value;
  },

  /**
   * Render one credit reading for the model picker.
   *
   * The harness shows this folded into a model's name, so it is kept to a few
   * words. `unlimited` is reported as such rather than as a large number, and a
   * reading with nothing usable in it renders as nothing at all.
   *
   * @param {object | undefined} quota
   * @returns {string | undefined}
   */
  formatQuota(quota) {
    if (quota === null || typeof quota !== 'object') return undefined;
    if (quota.unlimited === true) return '额度不限';
    if (typeof quota.total !== 'number' || !Number.isFinite(quota.total)) return undefined;
    return `${groupDigits(quota.total)} 积分`;
  },

  /**
   * The billing text for one model, when the upstream states one.
   *
   * The driver contract has no such member — `normalize` already folds billing
   * into the display name, because DSH's picker renders nothing else about a
   * model's price.
   */

  /** Nothing to release: the client is stateless. */
  async close() {
    client = undefined;
    keys = undefined;
    cachedCredits = undefined;
  }
};

/** Group a credit count for reading. */
function groupDigits(value) {
  const rounded = Math.trunc(value);
  const text = String(Math.abs(rounded));
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && (text.length - index) % 3 === 0) out += ',';
    out += text[index];
  }
  return rounded < 0 ? `-${out}` : out;
}
