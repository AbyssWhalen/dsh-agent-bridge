/**
 * Load the plugin the way the host does, and hand back what it registered.
 *
 * The probe has to exercise the **real** wiring — the adapter the harness would call, the catalog
 * the harness would read — not a hand-built `DriverAdapter`. Three defects this project has
 * already paid for were invisible from a hand-built instance: F-032 (the adapter's throw path),
 * F-035 (which options survive the harness boundary) and F-036 (how a session key is derived).
 * Driving `apply()` means a probe failure is a real failure.
 *
 * A full cordis context is not needed for that. `apply` uses exactly four things from `ctx`:
 * `llm.registerAdapter`, `logger`, `effect`, and `inject`. Supplying those is faithful for the
 * plugin's own behaviour and keeps the probe free of the desktop's boot order.
 */

/**
 * A logger that writes to stderr only when asked.
 *
 * The JSON line on stdout is the probe's output, so a chatty logger would corrupt it. `PROBE_LOGGER=1`
 * turns the same logger into a real one, which is how a probe finds out why a turn did nothing.
 *
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}}
 */
function stderrLogger() {
  const write = (tag) => (message) => process.stderr.write(`${tag} ${String(message)}\n`);
  return { debug: write('D'), info: write('I'), warn: write('W'), error: write('E') };
}

/** A logger that stays quiet unless asked: stderr output would corrupt the JSON line. */
function quietLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * @returns {Promise<{runtime: {snapshot: Function, adapter: Function, close: Function}}>}
 */
export async function loadBridge() {
  const plugin = await import('../lib/index.js');

  /** @type {Map<string, object>} */
  const adapters = new Map();
  const disposals = [];
  let bridge;

  const ctx = {
    logger: process.env['PROBE_LOGGER'] === '1' ? stderrLogger() : quietLogger(),
    effect(register) {
      // `apply` uses `effect` for teardown only; keeping the returned disposers lets the probe
      // shut the plugin down the same way the host does, which is what closes worker children.
      const dispose = register();
      if (typeof dispose === 'function') disposals.push(dispose);
      return dispose;
    },
    inject(_names, body) {
      // The web routes are irrelevant to a model call. `apply` guards on the injected context
      // arriving, so simply never calling back is the honest stand-in for "no web server".
      void body;
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter);
        return () => {
          for (const provider of providers) adapters.delete(provider);
        };
      }
    }
  };

  // `apply` keeps the bridge in a module-level set; `describe()` reads it back. That is how the
  // probe gets at the live instance without reaching into private state.
  plugin.apply(ctx, {});

  return {
    runtime: {
      /**
       * Wait until a provider is actually registered.
       *
       * `apply` starts the mount asynchronously — the catalog has to load and the install facts
       * have to be read before an adapter exists — so an immediate `adapter()` call reports
       * `NO_ADAPTER` for a vendor that is merely still starting. Polling is the honest way to
       * tell "slow" from "never".
       *
       * @param {string} provider
       * @param {number} [timeoutMs]
       */
      async waitFor(provider, timeoutMs = 60_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const adapter = adapters.get(provider);
          if (adapter !== undefined) {
            const models = await adapter.listModels(provider);
            if (models.length > 0) return adapter;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return adapters.get(provider);
      },
      /**
       * The provider's live surface.
       *
       * @param {string} provider
       */
      adapter(provider) {
        return adapters.get(provider);
      },
      async close() {
        for (const dispose of disposals.splice(0).reverse()) {
          try {
            await dispose();
          } catch {
            // A teardown failure is reported by the host, not by this probe.
          }
        }
      }
    }
  };
}
