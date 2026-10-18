/**
 * Session bookkeeping, shared by every driver.
 *
 * The pool owns the one thing every vendor here has in common: an open
 * conversation is *expensive* — a spawned worker, an authenticated handshake, a
 * warm history — so a second message in the same conversation should reuse it
 * rather than pay again. Everything else about a session belongs to the driver.
 *
 * The pool does **not** create sessions. It is handed one, because only the
 * caller knows what the session must be opened *for* — and because keeping
 * creation out of here is what lets the pool stay vendor-agnostic. It is a map
 * with three policies attached:
 *
 * 1. **One turn at a time per entry.** A busy entry is never handed out again.
 *    {@link Pool#take} reports *why* it could not be taken, which is what lets
 *    the caller tell "never seen" (open one) from "mid-turn" (open a throwaway
 *    one beside it).
 * 2. **Bounded size, LRU eviction, idle entries only.** A pool in which every
 *    entry is busy is left above budget rather than having a running turn
 *    cancelled to save a handle.
 * 3. **Explicit release.** A completed turn hands its entry back; a turn that
 *    failed, was aborted, or left the upstream history untrustworthy hands it to
 *    {@link Pool#discard}.
 *
 * @module dsh-agent-bridge/pool
 */

/** Separator between a conversation's key and an overflow counter. */
export const OVERFLOW_PREFIX = '#';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A bounded, LRU-ordered map of live sessions.
 *
 * @template T
 */
export class Pool {
  /** @type {Map<string, {handle: T, busy: boolean, lastUsed: number}>} */
  #entries = new Map();
  #budget;
  #close;
  #onError;
  #closed = false;

  /**
   * @param {object} options
   * @param {number} options.budget - most entries to keep once they are idle.
   * @param {(handle: T) => void | Promise<void>} options.close - release one.
   * @param {(error: unknown) => void} [options.onError] - reporting for a failed close.
   */
  constructor(options) {
    this.#budget = Math.max(1, Math.trunc(options.budget));
    this.#close = options.close;
    this.#onError = options.onError;
  }

  /** How many entries are held, idle and busy together. */
  get size() {
    return this.#entries.size;
  }

  /** Whether every held entry is mid-turn; false when the pool is empty. */
  get saturated() {
    if (this.#entries.size === 0) return false;
    for (const entry of this.#entries.values()) if (!entry.busy) return false;
    return true;
  }

  /**
   * Look at a key without taking it.
   *
   * @param {string} key
   * @returns {'absent' | 'busy' | 'idle'}
   */
  peek(key) {
    const entry = this.#entries.get(key);
    if (entry === undefined) return 'absent';
    return entry.busy ? 'busy' : 'idle';
  }

  /**
   * Take a key for a turn if it is idle.
   *
   * The three outcomes are deliberately distinct: a caller that cannot tell
   * absent from busy would either reopen a key that is mid-turn (clobbering a
   * running session) or fail a turn that a throwaway session would have served.
   *
   * @param {string} key
   * @returns {{state: 'taken', handle: T} | {state: 'absent'} | {state: 'busy'}}
   */
  take(key) {
    if (this.#closed) return { state: 'absent' };
    const entry = this.#entries.get(key);
    if (entry === undefined) return { state: 'absent' };
    if (entry.busy) return { state: 'busy' };
    entry.busy = true;
    entry.lastUsed = Date.now();
    return { state: 'taken', handle: entry.handle };
  }

  /**
   * Register a freshly created handle as busy.
   *
   * @param {string} key
   * @param {T} handle
   */
  put(key, handle) {
    this.#entries.set(key, { handle, busy: true, lastUsed: Date.now() });
    this.evict();
  }

  /**
   * Hand a key back after a completed turn.
   *
   * @param {string} key
   * @param {boolean} [keep] - whether the session may serve another turn. A
   *   driver that had to rebuild its upstream history passes `false` so the
   *   entry is closed instead of trusted.
   */
  release(key, keep = true) {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    if (!keep) {
      this.#entries.delete(key);
      void this.#closeSafely(entry.handle);
      return;
    }
    entry.busy = false;
    entry.lastUsed = Date.now();
    this.evict();
  }

  /**
   * Drop a key, closing its session because it cannot be trusted.
   *
   * Used when a turn failed, was aborted, or left the upstream history in a
   * state the pool's bookkeeping no longer describes.
   *
   * @param {string} key
   */
  discard(key) {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    void this.#closeSafely(entry.handle);
  }

  /**
   * Close idle entries, least recently used first, until at or under budget.
   *
   * Busy entries are never touched: a running turn is not worth cancelling to
   * save a handle, so the pool is allowed to sit above budget while every entry
   * is in use.
   */
  evict() {
    if (this.#entries.size <= this.#budget) return;
    const idle = [...this.#entries.entries()]
      .filter(([, entry]) => !entry.busy)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [key, entry] of idle) {
      if (this.#entries.size <= this.#budget) break;
      this.#entries.delete(key);
      void this.#closeSafely(entry.handle);
    }
  }

  /**
   * Close every entry and refuse further use.
   *
   * Busy entries are closed too: this runs on teardown, where leaving a child
   * process behind is worse than cutting a turn short.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.#closed = true;
    const handles = [...this.#entries.values()].map((entry) => entry.handle);
    this.#entries.clear();
    await Promise.allSettled(handles.map((handle) => this.#closeSafely(handle)));
  }

  /** Close one handle, reporting rather than throwing. */
  async #closeSafely(handle) {
    if (handle === undefined) return;
    try {
      await this.#close(handle);
    } catch (error) {
      this.#onError?.(error);
    }
  }

  /**
   * Deterministic discriminator for an overflow key.
   *
   * A counter is enough: the key only has to be absent from the map, and a
   * random suffix would make a leaked session harder to attribute.
   *
   * @returns {string}
   */
  static discriminator() {
    Pool.#counter += 1;
    return `o${Pool.#counter}`;
  }

  static #counter = 0;
}

/**
 * Format an epoch-millisecond instant in a locale-independent, sortable form.
 *
 * Kept here rather than in a driver so every vendor's "resets at" text reads the
 * same; the value is UTC and marked as such, never silently local.
 *
 * @param {number} epochMs
 * @returns {string}
 */
export function formatInstantUtc(epochMs) {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
