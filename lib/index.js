/**
 * dsh-agent-bridge — one provider group per vendor, from one host.
 *
 * This plugin reverse-proxies the models already entitled to the signed-in user
 * of several AI desktop clients into DSH. The design decision that shapes
 * everything here is that the vendors share **only** what is genuinely shared:
 *
 *   host  →  pooling, refresh cadence, model-name namespacing, provider
 *            registration, capability resolution, error mapping
 *   driver →  locating the install, reading the credential, speaking that one
 *            vendor's protocol
 *
 * The driver is the only part that an app update can break, so it is kept tiny
 * and isolated: each vendor is loaded separately, and a vendor that fails to load
 * degrades to "not offered" without touching the others. There is deliberately no
 * shared transport layer and no unified protocol conversion, because such a layer
 * would have to model every vendor's quirks and would then break for all of them
 * at once whenever it got one wrong.
 *
 * Each vendor is independently switchable. Vendors stop being worth serving on
 * their own schedule — a trial allowance ends, an account goes away — and the
 * switch is per vendor rather than per plugin so that retiring one never means
 * disturbing the other two. Turning a vendor off releases its provider route,
 * stops its refresh timer, and closes its sessions; nothing of it stays running.
 *
 * Everything registered here is additive: the plugin inserts its own providers
 * and leaves the profile's default model alone, and it reuses each desktop app's
 * existing sign-in rather than starting an OAuth flow of its own.
 *
 * @module dsh-agent-bridge
 */

import { Catalog, CATALOG_REFRESH_MS, CATALOG_RETRY_MS } from './catalog.js';
import { DriverAdapter } from './adapter.js';
import { validateDriver, toCatalogRow } from './driver.js';
import {
  COMPONENT_IDS,
  componentState,
  hasParkedCopy,
  hostKey,
  parkDriver,
  readState,
  restoreDriver,
  writeState
} from './state.js';
import { registerRoutes } from './routes.js';

/** The parts of the harness this plugin depends on. */
export const inject = ['llm'];

/**
 * The bridges serving this process, for diagnostics.
 *
 * More than one in the shipped shape: each vendor is its own Loader row, so each is
 * its own `apply()` and its own instance. A set, not a slot, so `describe()` reports
 * every vendor that is actually loaded instead of whichever row happened to load
 * last.
 *
 * @type {Set<Bridge>}
 */
const live = new Set();

/**
 * Route ids this plugin may register, in the order they are offered.
 *
 * Trae CN was dropped from the set deliberately. Its credential, model roster, and quota
 * are all reachable — the reversal is written up in the project's notes — but its chat turn
 * lives inside native modules that no local call path drives, so the vendor could only ever
 * have been offered in a half-working state. A vendor that can list models but cannot answer
 * a message is worse for the user than a vendor that is absent, so it is absent.
 */
export const DRIVER_IDS = [...COMPONENT_IDS];

/** Shortest and longest refresh interval a profile may configure, in ms. */
const MIN_POLL_MS = 5 * 1000;
const MAX_POLL_MS = 24 * 60 * 60 * 1000;

/**
 * The refresh interval, from the environment when it is sane.
 *
 * A short interval exists for development — watching a driver's first real answer
 * arrive — and the bounds keep a typo from turning into a request loop.
 *
 * @returns {number}
 */
function pollMs() {
  const raw = Number(process.env.DSH_BRIDGE_POLL_MS);
  if (!Number.isFinite(raw) || raw < MIN_POLL_MS || raw > MAX_POLL_MS) return CATALOG_REFRESH_MS;
  return Math.trunc(raw);
}

/**
 * Load one driver, reporting rather than throwing.
 *
 * The import is dynamic on purpose: a driver is plain JavaScript inside this
 * package, so a file that has become unparseable after an edit would otherwise
 * take the whole plugin — and therefore every other vendor — down with it.
 *
 * @param {string} id
 * @returns {Promise<{driver: object} | {reason: string}>}
 */
async function loadDriver(id) {
  let module;
  try {
    module = await import(`../drivers/${id}/index.js`);
  } catch (error) {
    return { reason: `could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  const checked = validateDriver(module.driver);
  if (!checked.ok) return { reason: checked.reason };
  if (typeof checked.driver.normalize !== 'function') {
    return { reason: 'missing the required member "normalize()"' };
  }
  return { driver: checked.driver };
}

/**
 * One vendor's live mount, or the reason it has none.
 *
 * The cached `located` value is what the settings page shows. It is refreshed on
 * demand rather than on every status read: locating a vendor means stat-ing its
 * install and, for some drivers, reading a credential file, and the page polls
 * while it is open.
 *
 * @typedef {{
 *   id: string,
 *   release: () => void,
 *   stop: () => void,
 *   adapter: DriverAdapter,
 *   catalog: Catalog,
 *   located?: unknown,
 *   locateError?: string
 * }} Mounted
 */

/**
 * Wire one driver into the harness.
 *
 * A failed registration is reported, not thrown: DSH rejects a second adapter
 * claiming a provider id it already has (`DUPLICATE_ADAPTER`), which happens
 * whenever another plugin in the same profile serves the same vendor. That is a
 * configuration fact about the profile, not a defect in this driver, and it must
 * not stop the other vendors from loading.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} driver
 * @returns {{ok: true, entry: Mounted} | {ok: false, reason: string}}
 */
function mount(ctx, driver) {
  const provider = driver.id;
  /** @type {(() => void) | undefined} */
  let release;
  const catalog = new Catalog({
    listModels: () => driver.listModels(),
    normalize: (raw) => toCatalogRow(driver.normalize(raw)),
    quota: driver.quota === undefined ? undefined : () => driver.quota(),
    label: provider,
    logger: ctx.logger,
    // The provider's display name carries the account balance, and DSH reads that
    // name once, at registration — which happens before the first refresh, since
    // registration must not wait on a spawned worker. Re-registering the same
    // routes re-reads the name, so the balance reaches the picker's group header
    // as soon as it is known, and again whenever it moves.
    onChange: () => {
      if (release === undefined) return;
      try {
        release.replace([provider]);
      } catch (error) {
        ctx.logger?.debug?.(`dsh-agent-bridge/${provider}: could not refresh the route: ${String(error)}`);
      }
    }
  });
  const adapter = new DriverAdapter({
    provider,
    displayName: driver.displayName,
    driver,
    catalog,
    logger: ctx.logger
  });
  // Registration is the one thing that has to be exact: DSH routes a model by
  // its provider id, so a second adapter claiming the same id is rejected and a
  // missing one makes the model unreachable from the selection UI.
  try {
    release = ctx.llm.registerAdapter([provider], adapter);
  } catch (error) {
    const reason = `could not be registered: ${error instanceof Error ? error.message : String(error)}`;
    ctx.logger?.warn?.(`dsh-agent-bridge/${provider}: ${reason}`);
    return { ok: false, reason };
  }
  const stop = catalog.start({ intervalMs: pollMs(), retryMs: CATALOG_RETRY_MS });
  return {
    ok: true,
    entry: { id: provider, release, stop, adapter, catalog }
  };
}

/**
 * Tear one vendor down completely.
 *
 * Order matters, and each step exists to close a window the next one would
 * otherwise inherit. The announcement gate goes first: a refresh already in
 * flight will still land, and if it can still announce it will re-register the
 * route we are about to release. The timer goes next so no new refresh starts;
 * the route is released before the sessions are closed because a released route
 * can no longer be asked for a model; and the close comes last so it can await
 * work the earlier steps stopped.
 *
 * @param {Mounted} entry
 * @returns {Promise<void>}
 */
async function unmount(entry) {
  try {
    entry.catalog?.halt?.();
  } catch {
    /* a catalog that cannot be silenced is already unreachable */
  }
  try {
    entry.stop();
  } catch {
    /* a timer that is already gone is the desired state */
  }
  try {
    entry.release();
  } catch {
    /* an already-released route cannot be released twice */
  }
  try {
    await entry.adapter.close();
  } catch {
    /* close is best-effort; nothing below depends on it */
  }
}

/**
 * The switchboard: what each vendor should be doing, against what it is doing.
 *
 * One instance per apply(), so a hot reload cannot leave a stale mount behind a
 * fresh one.
 *
 * Two shapes ship from this one class:
 *
 *   row        one Loader row, one vendor. The row is the switch, so the instance
 *              mounts its vendor whenever it is loaded and never consults the
 *              saved `disabled` list — two switches for one vendor would be two
 *              truths, and the page would eventually show the wrong one.
 *   aggregate  one row, every vendor, switched from this plugin's own page. This
 *              is what a profile whose patch predates the per-vendor rows gets.
 */
class Bridge {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{components?: readonly string[]}} [options]
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.components = [...(options.components ?? COMPONENT_IDS)];
    /** The single vendor a row instance serves, or `undefined` for the aggregate. */
    this.component = this.components.length === 1 ? this.components[0] : undefined;
    /** @type {Map<string, Mounted>} */
    this.mounted = new Map();
    /** @type {Map<string, string>} */
    this.failed = new Map();
    /** @type {Map<string, string>} */
    this.notes = new Map();
    const { state, note } = readState();
    this.state = state;
    if (note !== undefined) {
      this.ctx.logger?.warn?.(`dsh-agent-bridge: ${note}`);
      this.notes.set('state', note);
    }
    /** Serializes change() calls so two page clicks cannot interleave mounts. */
    this.queue = Promise.resolve();
    this.closed = false;
  }

  /** `row` when the Loader owns the switch, `aggregate` when this plugin does. */
  get mode() {
    return this.component === undefined ? 'aggregate' : 'row';
  }

  /**
   * What one vendor's switch says, in this instance's shape.
   *
   * A row instance is on because DSH loaded it; the only thing that can still
   * hold it back is a parked driver, which is not "off" but "uninstalled".
   *
   * @param {string} id
   * @returns {'on' | 'off' | 'removed'}
   */
  wanted(id) {
    if (this.mode === 'row') return hasParkedCopy(id) ? 'removed' : 'on';
    return componentState(this.state, id);
  }

  /** Persist the current state, reporting a write failure without throwing. */
  #persist() {
    try {
      writeState(this.state);
    } catch (error) {
      const note = `could not save the component state: ${error instanceof Error ? error.message : String(error)}`;
      this.ctx.logger?.warn?.(`dsh-agent-bridge: ${note}`);
      this.notes.set('write', note);
    }
  }

  /**
   * Bring every vendor in line with the saved state.
   *
   * Vendors are handled one at a time and each one's failure is contained: a
   * driver that will not load records a reason and the loop continues. That is
   * the isolation the whole design rests on.
   *
   * @returns {Promise<void>}
   */
  async sync() {
    for (const id of this.components) {
      if (this.closed) return;
      await this.#syncOne(id);
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async #syncOne(id) {
    const want = this.wanted(id);
    const current = this.mounted.get(id);
    if (want !== 'on') {
      if (current !== undefined) {
        this.mounted.delete(id);
        await unmount(current);
        this.ctx.logger?.info?.(`dsh-agent-bridge/${id}: stopped (${want})`);
      }
      this.failed.delete(id);
      return;
    }
    if (current !== undefined) return;
    const loaded = await loadDriver(id);
    if (!('driver' in loaded)) {
      this.failed.set(id, loaded.reason);
      this.ctx.logger?.warn?.(`dsh-agent-bridge/${id}: ${loaded.reason}`);
      return;
    }
    // A close can land while an import is in flight; honouring it here is what
    // keeps a mount from appearing after teardown.
    if (this.closed) return;
    const result = mount(this.ctx, loaded.driver);
    if (!result.ok) {
      this.failed.set(id, result.reason);
      return;
    }
    this.failed.delete(id);
    this.mounted.set(id, result.entry);
    this.ctx.logger?.info?.(`dsh-agent-bridge/${id}: serving ${loaded.driver.displayName}`);
    // Announced after registration so a slow check never delays a provider.
    await this.#locate(result.entry);
  }

  /**
   * Refresh one mount's install facts, keeping the last good answer on failure.
   *
   * @param {Mounted} entry
   * @returns {Promise<void>}
   */
  async #locate(entry) {
    try {
      entry.located = await entry.adapter.locate();
      entry.locateError = undefined;
      const reason = /** @type {{reason?: unknown}} */ (entry.located)?.reason;
      if (typeof reason === 'string') {
        this.ctx.logger?.warn?.(`dsh-agent-bridge/${entry.id}: ${reason}`);
      }
    } catch (error) {
      entry.locateError = error instanceof Error ? error.message : String(error);
      this.ctx.logger?.warn?.(`dsh-agent-bridge/${entry.id}: could not check the install: ${entry.locateError}`);
    }
  }

  /**
   * Run a state change, one at a time.
   *
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  #change(work) {
    const next = this.queue.then(work, work);
    // The queue must not carry a rejection forward: one failed click would
    // otherwise make every later click fail with the same error.
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Turn one vendor on or off.
   *
   * @param {string} id
   * @param {boolean} enabled
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  setEnabled(id, enabled) {
    return this.#change(async () => {
      if (!this.components.includes(id)) return { ok: false, reason: `unknown component ${id}` };
      if (this.mode === 'row') {
        // The Loader row is the switch now. Changing a second flag here would make
        // the page disagree with the switch directly above it, so this refuses and
        // names the control that does work.
        return { ok: false, reason: 'use this component\u2019s switch in the plugin\u2019s component list' };
      }
      const removed = this.state.removed.includes(id);
      if (enabled && removed) {
        return { ok: false, reason: 'this component was uninstalled; restore it first' };
      }
      const disabled = new Set(this.state.disabled);
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      this.state = { ...this.state, disabled: [...disabled] };
      this.#persist();
      this.notes.delete('action');
      await this.#syncOne(id);
      if (!enabled) return { ok: true };
      const failure = this.failed.get(id);
      return failure === undefined ? { ok: true } : { ok: true, reason: failure };
    });
  }

  /**
   * Move one vendor's files out of the package.
   *
   * The vendor is stopped first, so nothing holds an open handle to a file that
   * is about to move.
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  uninstall(id) {
    return this.#change(async () => {
      if (!this.components.includes(id)) return { ok: false, reason: `unknown component ${id}` };
      const current = this.mounted.get(id);
      if (current !== undefined) {
        this.mounted.delete(id);
        await unmount(current);
      }
      const parked = parkDriver(id);
      if (!parked.ok) {
        this.notes.set('action', parked.reason);
        // The switch still moves: leaving the vendor enabled would make the next
        // boot try to mount files the user asked to remove.
        if (this.mode === 'aggregate') {
          this.state = {
            ...this.state,
            disabled: [...new Set([...this.state.disabled, id])]
          };
          this.#persist();
        }
        return { ok: false, reason: parked.reason };
      }
      const removed = new Set(this.state.removed);
      removed.add(id);
      const disabled = new Set(this.state.disabled);
      disabled.delete(id);
      this.state = { ...this.state, removed: [...removed], disabled: [...disabled] };
      this.#persist();
      this.failed.delete(id);
      this.ctx.logger?.info?.(`dsh-agent-bridge/${id}: uninstalled (files kept at ${parked.parkedAt})`);
      return { ok: true };
    });
  }

  /**
   * Put a removed vendor's files back.
   *
   * In the aggregate shape this resumes the ability to run the vendor, not the
   * decision to: a user who removed a component to be rid of it should not have it
   * start serving models again because they undid the removal.
   *
   * In the row shape there is no such decision to restore — the row is on — so the
   * files come back and the vendor starts serving again. That is what the person
   * pressing 恢复 on a row means.
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  restore(id) {
    return this.#change(async () => {
      if (!this.components.includes(id)) return { ok: false, reason: `unknown component ${id}` };
      const restored = restoreDriver(id);
      if (!restored.ok) {
        this.notes.set('action', restored.reason);
        return { ok: false, reason: restored.reason };
      }
      this.state = {
        ...this.state,
        removed: this.state.removed.filter((item) => item !== id),
        ...(this.mode === 'row' ? {} : { disabled: [...new Set([...this.state.disabled, id])] })
      };
      this.#persist();
      if (this.mode === 'row') {
        this.notes.delete('action');
        await this.#syncOne(id);
        const failure = this.failed.get(id);
        this.ctx.logger?.info?.(`dsh-agent-bridge/${id}: restored and serving again`);
        return failure === undefined ? { ok: true } : { ok: true, reason: failure };
      }
      this.ctx.logger?.info?.(`dsh-agent-bridge/${id}: restored; still switched off`);
      return { ok: true };
    });
  }

  /**
   * Re-read one vendor's install facts and model list.
   *
   * @param {string} id
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  refresh(id) {
    return this.#change(async () => {
      const entry = this.mounted.get(id);
      if (entry === undefined) return { ok: false, reason: 'this component is not running' };
      await this.#locate(entry);
      try {
        await entry.catalog.refresh();
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true };
    });
  }

  /**
   * What the settings page renders.
   *
   * Built from the same values the picker uses, so the page cannot claim a model
   * the picker would not offer. A vendor that is off reports its switch state and
   * nothing else, because there is no live catalog to describe.
   *
   * `firstCatalogMs` covers the one window where an empty catalogue is misleading:
   * a component that was switched on a moment ago, whose driver is still
   * authenticating and enumerating. Reading it immediately would report "no
   * models" for a vendor that is about to offer several, and the reader has no way
   * to tell that apart from an account with nothing in it. The wait is bounded and
   * applies only to catalogues that have never answered, so a steady page still
   * reads synchronously.
   *
   * @param {{firstCatalogMs?: number, only?: string}} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async snapshot(options = {}) {
    const firstCatalogMs = typeof options.firstCatalogMs === 'number' ? options.firstCatalogMs : 0;
    const only = typeof options.only === 'string' ? options.only : undefined;
    const ids = only === undefined ? this.components : this.components.filter((id) => id === only);
    if (firstCatalogMs > 0) {
      await Promise.all(
        ids.map((id) => {
          const entry = this.mounted.get(id);
          return entry !== undefined && entry.catalog.status.fetchedAtMs === undefined
            ? entry.catalog.whenReady(firstCatalogMs).catch(() => false)
            : undefined;
        })
      );
    }
    const components = ids.map((id) => {
      const state = this.wanted(id);
      const entry = this.mounted.get(id);
      const base = {
        id,
        state,
        // Per component, not only per document: the page's row view reads one
        // component out of its own document and must know whether on/off is its
        // business or the Loader row's.
        mode: this.mode,
        parked: hasParkedCopy(id),
        ...(this.failed.has(id) ? { reason: this.failed.get(id) } : {})
      };
      if (entry === undefined) return base;
      const catalog = entry.catalog.status;
      return {
        ...base,
        displayName: entry.adapter.displayName,
        located: entry.located,
        ...(entry.locateError === undefined ? {} : { locateError: entry.locateError }),
        models: entry.catalog.current().map((row) => ({ ...row })),
        quota: entry.catalog.quota(),
        catalog
      };
    });
    return {
      status: 'ok',
      package: 'dsh-agent-bridge',
      // `row` means DSH's own component switch owns on/off, so the page must not
      // offer a second one; `aggregate` means this plugin's page does.
      mode: this.mode,
      ...(this.component === undefined ? {} : { component: this.component }),
      key: hostKey(),
      components,
      ...(this.notes.size === 0 ? {} : { notes: Object.fromEntries(this.notes) })
    };
  }

  /** Stop everything. */
  async close() {
    this.closed = true;
    await this.queue.catch(() => undefined);
    const entries = [...this.mounted.values()];
    this.mounted.clear();
    await Promise.allSettled(entries.map((entry) => unmount(entry)));
  }
}

/**
 * Read the vendors one Loader row asks for.
 *
 * DSH composes a bundle patch into Loader rows, and a row's `config` reaches
 * `apply()` verbatim. So the shipped patch declares one row per vendor —
 *
 *     - id: agent-bridge-workbuddy
 *       name: dsh-agent-bridge
 *       config: { component: workbuddy }
 *
 * — and each row becomes its own instance, its own provider, its own switch in
 * the plugin's component list. A row with no config (an older profile patch) keeps
 * the original shape: one instance serving every vendor.
 *
 * An unknown name is refused rather than trusted, because a typo in a hand-edited
 * patch would otherwise mount nothing and look like a dead plugin.
 *
 * @param {unknown} config
 * @returns {{ids: string[], problem?: string}}
 */
function componentIdsFrom(config) {
  const raw = typeof config === 'object' && config !== null ? /** @type {Record<string, unknown>} */ (config) : {};
  const value = raw.component;
  if (value === undefined) return { ids: [...COMPONENT_IDS] };
  const ids = Array.isArray(value) ? value : [value];
  const unknown = ids.filter((id) => typeof id !== 'string' || !COMPONENT_IDS.includes(id));
  if (unknown.length > 0 || ids.length === 0) {
    return {
      ids: [...COMPONENT_IDS],
      problem: `ignoring unknown component ${JSON.stringify(value)}; serving ${COMPONENT_IDS.join(', ')}`
    };
  }
  return { ids: /** @type {string[]} */ (ids) };
}

/**
 * Install the vendors this row serves, and keep out of the way of the rest.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} [config]
 */
export function apply(ctx, config) {
  const { ids, problem } = componentIdsFrom(config);
  if (problem !== undefined) ctx.logger?.warn?.(`dsh-agent-bridge: ${problem}`);
  const bridge = new Bridge(ctx, { components: ids });
  const ready = bridge.sync().catch((error) => {
    ctx.logger?.warn?.(`dsh-agent-bridge: could not start: ${String(error)}`);
  });

  // The routes are mounted regardless of which vendors are on: the page is how a
  // user reads one, so it cannot depend on any of them running.
  ctx.inject(['webServer'], (webCtx) => {
    registerRoutes(webCtx, bridge, ctx.logger);
  });

  ctx.effect(() => () => {
    // Teardown runs after a boot that may still be in flight; awaiting it is what
    // guarantees nothing spawns a worker after the plugin is gone.
    live.delete(bridge);
    return ready.then(() => bridge.close());
  });

  live.add(bridge);
}

/** Provider ids this plugin intends to offer, whether or not they loaded. */
export function providers() {
  return [...DRIVER_IDS];
}

/**
 * Diagnostics for `doctor`-style output: what loaded, what did not, and why.
 *
 * Reads every loaded instance, so three rows report three vendors rather than one.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
export async function describe() {
  if (live.size === 0) return { drivers: [] };
  const snapshots = await Promise.all([...live].map((bridge) => bridge.snapshot().catch(() => undefined)));
  const drivers = [];
  for (const snapshot of snapshots) {
    if (snapshot === undefined) continue;
    for (const component of /** @type {{id: string, state: string}[]} */ (snapshot.components)) {
      drivers.push({ id: component.id, state: component.state });
    }
  }
  return { drivers };
}
