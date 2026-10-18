/**
 * The Qoder driver.
 *
 * Implements the bridge's driver contract for Qoder CN by driving the desktop
 * app's own bundled worker runtime. Everything here is one of three things: where
 * the app is, who is signed in, or how to talk to that runtime — the rest of the
 * plugin never sees any of it.
 *
 * The runtime is reused rather than reimplemented for the reason documented in
 * `session.js`: the public gateway refuses third-party model requests, and the
 * worker *is* the transport that can reach the model server.
 *
 * @module dsh-agent-bridge/drivers/qoder
 */
import { QoderConversation } from './conversation.js';
import { normalizeModel } from './models.js';
import { credentialAccount, readCredential, resolveInstallDir, resolveRuntime } from './locate.js';
import { fetchQuota, formatQuota } from './upstream.js';

/** The provider route this driver is registered under. */
const ID = 'qoder';

/** The human name of the provider group. */
const DISPLAY_NAME = 'Qoder';

/**
 * How long a credential lookup is trusted, in ms.
 *
 * Reading it unseals a DPAPI blob through a PowerShell child, which is far too
 * expensive to repeat per turn, but the app can be signed out from underneath a
 * long-lived host — so it is re-read periodically rather than once.
 */
const CREDENTIAL_TTL_MS = 5 * 60 * 1000;

/** @type {{at: number, value: object} | undefined} */
let cachedCredential;

/** The credential, re-read when the cached copy ages out. */
async function loadCredential() {
  const now = Date.now();
  if (cachedCredential !== undefined && now - cachedCredential.at < CREDENTIAL_TTL_MS) return cachedCredential.value;
  const value = readCredential();
  cachedCredential = { at: now, value };
  return value;
}

/** Drop the cached credential, so the next read picks up a sign-in swap. */
function forgetCredential() {
  cachedCredential = undefined;
}

/**
 * Open a conversation over the installed runtime.
 *
 * A missing install is reported as an error carrying the reason, because this is
 * called from a listing where the message ends up in the catalog's status — the
 * user needs to be told "Qoder is not installed" rather than shown an empty group
 * with no explanation.
 *
 * @param {{debug?: Function, info?: Function, warn?: Function}} [logger]
 */
async function openConversation(logger) {
  const installDir = resolveInstallDir();
  if (installDir === undefined) throw new Error('qoder: the desktop app is not installed');
  const runtime = resolveRuntime(installDir);
  if (runtime === undefined) throw new Error('qoder: the installed app carries no worker runtime');
  return new QoderConversation({
    runtimePath: runtime.runtimePath,
    sdkVersion: runtime.sdkVersion,
    cwd: process.cwd(),
    resolveCredential: () => loadCredential(),
    logger
  });
}

/**
 * The catalog listing conversation, kept between refreshes.
 *
 * One child, reused: a cold runtime costs seconds to authenticate, and the
 * catalog is re-read on a timer.
 *
 * @type {{conversation: QoderConversation} | undefined}
 */
let catalogConversation;

/** Close the reusable listing child, if one is open. */
async function closeCatalogConversation() {
  const held = catalogConversation;
  catalogConversation = undefined;
  if (held !== undefined) await held.conversation.close().catch(() => undefined);
}

/** The driver. */
export const driver = {
  id: ID,
  displayName: DISPLAY_NAME,

  /**
   * Where the app is, and whether anyone is signed in.
   *
   * Never throws: "not installed" and "signed out" are both ordinary answers that
   * the host renders as a hidden provider group, not as a failure.
   */
  async locate() {
    const installDir = resolveInstallDir();
    if (installDir === undefined) return { installed: false, signedIn: false };
    const runtime = resolveRuntime(installDir);
    if (runtime === undefined) return { installed: true, root: installDir, signedIn: false };
    let signedIn = false;
    let account;
    try {
      const credential = await loadCredential();
      signedIn = true;
      account = credentialAccount(credential);
    } catch {
      signedIn = false;
    }
    return {
      installed: true,
      version: runtime.version,
      root: installDir,
      signedIn,
      ...(account === undefined ? {} : { account })
    };
  },

  /**
   * The account's live model entitlements.
   *
   * Read from the runtime rather than a table, because the per-model context
   * windows and reasoning levels are whatever this account is actually entitled
   * to. A failed listing drops the reusable child, so the next attempt starts
   * clean instead of retrying a wedged one.
   */
  async listModels() {
    catalogConversation ??= { conversation: await openConversation() };
    try {
      return await catalogConversation.conversation.listModels();
    } catch (error) {
      await closeCatalogConversation();
      forgetCredential();
      throw error;
    }
  },

  /**
   * One conversation.
   *
   * The `key` is the host's pool key, used only for diagnostics here: the host
   * owns the sharing decision, and this driver owns nothing about lifetime beyond
   * the process it spawns.
   */
  async openSession(options = {}) {
    const conversation = await openConversation(options.logger);
    return {
      send: (messages, sendOptions) => conversation.send(messages, sendOptions),
      close: () => conversation.close()
    };
  },

  /** One upstream row into the shared catalog shape. */
  normalize: normalizeModel,

  /**
   * The account's remaining balance.
   *
   * Qoder publishes this over the plain OpenAPI host — the one endpoint the
   * gateway does *not* refuse third parties — so it needs no worker session.
   *
   * A cached credential can outlive the token inside it: the balance then answers
   * 401 while model traffic, which mints its own short-lived job token, keeps
   * working. That combination used to drop the figure from the header with no
   * trace, so an auth-shaped failure is retried once against a freshly read
   * credential before it is reported.
   */
  async quota() {
    const credential = await loadCredential();
    try {
      return await fetchQuota(credential);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/http (?:401|403)/u.test(message)) throw error;
      forgetCredential();
      return fetchQuota(await loadCredential());
    }
  },

  /** The balance text folded into every model name. */
  formatQuota,

  /** Release every process this driver owns. */
  async close() {
    await closeCatalogConversation();
  }
};
