/**
 * The live, per-account view of a driver's models and quota.
 *
 * DSH reads model metadata **synchronously** while rendering a picker, but both
 * facts come from somewhere slow: a spawned worker, a CLI, an HTTPS call. This
 * store is the seam between those two worlds. It holds the last known good answer
 * so a render never blocks, and it refreshes on a timer and on demand.
 *
 * Three states it can be in, all of them supported:
 *
 * - **Loaded.** Models, maybe a balance, `current()` returns the rows.
 * - **Empty.** No models. This is how DSH hides a provider group, so a user who
 *   signs in *after* DSH started gets the models without a restart — the timer
 *   keeps looking.
 * - **Failed but previously loaded.** The old snapshot is kept. A machine that is
 *   briefly offline must not lose its model list, and an unreachable account is
 *   not the same thing as an empty one — that distinction is what `status` is for.
 *
 * Everything vendor-specific is injected: how to enumerate models, what counts as
 * a usable row, and where a balance comes from. Vendors without a balance simply
 * pass no quota reader and get none.
 *
 * @module dsh-agent-bridge/catalog
 */

/** How often the account facts are re-read while nothing is wrong, in ms. */
export const CATALOG_REFRESH_MS = 5 * 60 * 1000;

/** Backoff after a failed refresh, in ms. */
export const CATALOG_RETRY_MS = 30 * 1000;

/**
 * How long a balance stays published while its reader keeps failing, in ms.
 *
 * Long enough to ride out an expired token, a signed-out blip, or a flaky minute;
 * short enough that a broken endpoint stops claiming a figure the account no
 * longer supports.
 */
export const QUOTA_STALE_MS = 15 * 60 * 1000;

/**
 * Longest a capability lookup waits for the first catalog answer, in ms.
 *
 * A cold driver costs seconds to authenticate and enumerate. This has to clear
 * that comfortably while staying bounded, so an unreachable account cannot hang a
 * request indefinitely.
 */
export const READY_WAIT_MS = 20 * 1000;

/** Run `fn`, reporting failure as a message rather than throwing. */
async function attempt(fn) {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One driver's model catalog plus its account facts, cached for reading.
 *
 * @template TRaw
 */
export class Catalog {
  /** @type {Record<string, unknown>[]} */
  #models = [];
  #quota;
  /** Why the last refresh failed, when it did. */
  #error;
  /** When the balance was last read successfully, for the staleness bound. */
  #quotaAtMs;
  #now;
  #fetchedAtMs;
  #inflight;
  #settled = false;
  #readyPromise;
  #listModels;
  #normalize;
  #readQuota;
  #label;
  #logger;
  #onChange;
  /** What the last announced snapshot looked like, for change detection. */
  #signature;
  /** Set once the host has torn this catalog down; silences every later announce. */
  #halted = false;

  /**
   * @param {object} options
   * @param {() => Promise<readonly TRaw[]>} options.listModels - the driver's own
   *   enumeration, credentials included; an empty list is a valid answer.
   * @param {(raw: unknown) => Record<string, unknown> | undefined} options.normalize
   *   one upstream row into the shared catalog shape; `undefined` drops it.
   * @param {(() => Promise<unknown> | unknown) | undefined} [options.quota] - the
   *   driver's optional balance reader.
   * @param {string} options.label - the driver id, used only in log lines.
   * @param {{debug?: Function, info?: Function, warn?: Function}} [options.logger]
   * @param {(() => number) | undefined} [options.now] - clock, for tests.
   * @param {(() => void) | undefined} [options.onChange] - called after a refresh
   *   that changed the published snapshot. The host uses it to re-publish the
   *   provider's display name, which carries the account balance and is therefore
   *   stale until the first refresh lands.
   */
  constructor(options) {
    this.#listModels = options.listModels;
    this.#normalize = options.normalize;
    this.#readQuota = options.quota;
    this.#label = options.label;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange;
  }

  /** The models to advertise right now; empty means "hide this provider". */
  current() {
    return this.#models;
  }

  /** Balance facts, or `undefined` when never fetched or not provided. */
  quota() {
    return this.#quota;
  }

  /** Why the catalog is in its current state, for diagnostics. */
  get status() {
    return {
      models: this.#models.length,
      fetchedAtMs: this.#fetchedAtMs,
      hasQuota: this.#quota !== undefined,
      ...(this.#error === undefined ? {} : { error: this.#error })
    };
  }

  /** Replace the snapshot wholesale. */
  #publish(models, quota) {
    this.#models = models;
    this.#quota = quota;
    this.#fetchedAtMs = Date.now();
    this.#error = undefined;
    this.#announce();
  }

  /** Adopt an empty state: no models, no balance. */
  #markEmpty(reason) {
    this.#models = [];
    this.#quota = undefined;
    this.#fetchedAtMs = Date.now();
    if (reason !== undefined) this.#error = reason;
    this.#announce();
  }

  /**
   * Tell the host when the published snapshot actually changed.
   *
   * Gated on a signature rather than fired per refresh: the handler re-publishes
   * the provider's display name, which emits a catalog-updated event and makes
   * every open picker re-render. Doing that once per refresh interval for an
   * account whose balance never moves would be churn for nothing.
   */
  #announce() {
    if (this.#halted) return;
    if (this.#onChange === undefined) return;
    const signature = this.#signatureOf();
    if (signature === this.#signature) return;
    this.#signature = signature;
    try {
      this.#onChange();
    } catch (error) {
      this.#logger?.debug?.(`bridge/${this.#label}: change handler failed: ${String(error)}`);
    }
  }

  /** A comparable fingerprint of everything the display depends on. */
  #signatureOf() {
    const ids = this.#models.map((row) => String(row.id)).join('\u0000');
    let quota;
    try {
      quota = JSON.stringify(this.#quota) ?? 'undefined';
    } catch {
      // A quota record is plain data in every driver here; a value that cannot be
      // serialized is treated as changed rather than silently compared as equal.
      quota = String(Math.random());
    }
    return `${ids}\u0001${quota}`;
  }

  /**
   * Re-read the model list and the balance.
   *
   * Overlapping calls share one pass: a picker open during a timer tick must not
   * launch a second worker handshake.
   *
   * The shared pass is cleared once it settles, which is what makes the next call a
   * real one. Leaving it set made every refresh after the first return the same
   * settled promise, so the timer in {@link start} fired faithfully every five
   * minutes and did nothing — the model list and the balance were frozen at the
   * value read at boot. A balance that never moves is indistinguishable from one
   * that cannot move, which is exactly how it was reported.
   *
   * @returns {Promise<{models: readonly unknown[], quota?: unknown, error?: string}>}
   */
  refresh() {
    if (this.#inflight !== undefined) return this.#inflight;
    const run = this.#refreshOnce();
    this.#inflight = run;
    const clear = () => {
      if (this.#inflight === run) this.#inflight = undefined;
    };
    // Both arms, so a failed pass is cleared too and the retry timer can work.
    void run.then(clear, clear);
    return run;
  }

  async #refreshOnce() {
    const listed = await attempt(() => this.#listModels());
    if (listed.error !== undefined) {
      // A first-load failure with nothing cached is indistinguishable from a
      // signed-out account from the user's point of view, and reporting it that
      // way is what keeps the provider retryable instead of permanently broken.
      if (this.#models.length === 0) this.#markEmpty(undefined);
      this.#error = listed.error;
      return { models: this.#models, error: this.#error };
    }

    const rows = Array.isArray(listed.value) ? listed.value : [];
    const models = [];
    for (const raw of rows) {
      const normalized = this.#normalize(raw);
      if (normalized !== undefined) models.push(normalized);
    }

    let quota;
    if (this.#readQuota !== undefined) {
      const fetched = await attempt(() => this.#readQuota());
      if (fetched.error !== undefined) {
        // A balance is decoration; a model list without one is still usable. A
        // balance that was readable a minute ago is not decoration, though: a
        // single failed poll used to erase the figure from the header and leave it
        // blank until the next successful refresh, which reads as "the credits are
        // gone". Keep the last good reading instead.
        this.#logger?.debug?.(`bridge/${this.#label}: balance unavailable: ${fetched.error}`);
        // Retaining the figure is only honest while the failure looks transient.
        // A dead endpoint would otherwise keep showing an old balance forever, and
        // an old number is worse than no number: it reads as a live one.
        const staleForMs = this.#quotaAtMs === undefined ? 0 : this.#now() - this.#quotaAtMs;
        if (this.#quota !== undefined && staleForMs > QUOTA_STALE_MS) {
          this.#logger?.warn?.(
            `bridge/${this.#label}: dropping a balance that is ${Math.round(staleForMs / 60_000)} minutes old`
          );
          quota = undefined;
        } else {
          quota = this.#quota;
        }
      } else {
        quota = fetched.value;
        this.#quotaAtMs = this.#now();
      }
    }

    this.#publish(models, quota);
    return { models, quota };
  }

  /**
   * Resolve once the first refresh has settled, one way or the other.
   *
   * `current()` is the synchronous read every render uses, which means it answers
   * "no models" for as long as the first fetch takes. That is fine for a picker,
   * but not for capability resolution: the harness validates a requested
   * reasoning effort against the model's advertised levels, and an empty catalog
   * advertises none — so a configured default model would fail
   * `UNSUPPORTED_REASONING_EFFORT` for the whole startup window.
   *
   * Waiting here closes that window, and the wait is bounded so a machine that can
   * never reach the account still fails promptly rather than hanging a turn.
   *
   * @param {number} [deadlineMs] - longest time to wait for the first answer.
   * @returns {Promise<boolean>} whether any model is available; the caller reads `current()`.
   */
  whenReady(deadlineMs = READY_WAIT_MS) {
    if (this.#settled) return Promise.resolve(this.#models.length > 0);
    this.#readyPromise ??= this.#firstRefresh();
    return Promise.race([
      this.#readyPromise,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), deadlineMs);
        timer.unref?.();
      })
    ]);
  }

  /** Run the first refresh and record that the catalog has settled once. */
  async #firstRefresh() {
    try {
      await this.refresh();
    } finally {
      this.#settled = true;
      this.#readyPromise = undefined;
    }
    return this.#models.length > 0;
  }

  /**
   * Silence this catalog for good.
   *
   * Stopping the timer is not enough on its own: a refresh that is already in
   * flight — a worker handshake, an HTTPS call — keeps running, and when it lands
   * it publishes and announces. The host's change handler re-registers the
   * provider route so the balance can reach the group header, so an announce that
   * arrives *after* the route was released puts the provider back: the row the
   * user just switched off reappears, and the teardown looks like it leaked.
   *
   * The flag is set before the route is released, which is what makes the window
   * impossible rather than merely unlikely. Results still land in the local
   * snapshot; nobody is told about them, and the snapshot dies with the mount.
   */
  halt() {
    this.#halted = true;
  }

  /**
   * Start the refresh loop.
   *
   * The cadence follows the outcome: a healthy read — including an empty one,
   * because a sign-in must be noticed without a restart — is retried on the normal
   * interval, while a transport failure backs off so a dead endpoint is not
   * hammered.
   *
   * @param {{intervalMs?: number, retryMs?: number}} [options]
   * @returns {() => void} a stop function.
   */
  start(options = {}) {
    let stopped = false;
    let timer;
    const interval = options.intervalMs ?? CATALOG_REFRESH_MS;
    const retry = options.retryMs ?? CATALOG_RETRY_MS;
    const tick = async () => {
      if (stopped) return;
      const result = await this.refresh().catch(() => undefined);
      if (stopped) return;
      timer = setTimeout(() => void tick(), result?.error === undefined ? interval : retry);
      timer.unref?.();
    };
    timer = setTimeout(() => void tick(), 0);
    timer.unref?.();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }
}
