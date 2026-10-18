/**
 * The two HTTP routes behind the plugin's own settings page.
 *
 * DSH loads a plugin's browser half into the page the harness already serves, so
 * the page and this host share an origin. That makes a same-origin `fetch` the
 * whole transport — no second port, no IPC bridge, nothing to configure — and it
 * makes the origin check below the real trust boundary.
 *
 * Two routes, not one, because they differ in what a mistake costs:
 *
 *   GET  status   read-only; answers what each component is doing right now
 *   POST action   changes state; needs the per-process key the status document
 *                 hands the page, so a page that merely guessed the path cannot
 *                 switch a vendor off or delete its files
 *
 * The split is the same shape the WorkBuddy plugin uses, for the same reason: a
 * loopback Host/Origin check stops a DNS-rebinding *page* from reading the status
 * document, but it does not authorize a state change, because a page served from
 * loopback is exactly what a rebinding attack has.
 *
 * @module dsh-agent-bridge/routes
 */

import { COMPONENT_IDS } from './state.js';

/**
 * The one path prefix every route of this plugin lives under.
 *
 * A per-vendor instance appends its own id (`…/dsh-agent-bridge/qoder`), so the
 * aggregate form and the row form share one namespace and one reader.
 */
export const BASE_PREFIX = '/plugins/dsh-agent-bridge';

/** Path of the read-only status document, for the aggregate (no-config) form. */
export const STATUS_PATH = `${BASE_PREFIX}/status`;

/** Path of the state-changing action endpoint, for the aggregate form. */
export const ACTION_PATH = `${BASE_PREFIX}/action`;

/**
 * The two paths one instance serves.
 *
 * @param {string} [component] - the vendor this instance serves; omitted for the
 *   aggregate form, which serves all of them behind one switchboard.
 * @returns {{status: string, action: string}}
 */
export function pathsFor(component) {
  const prefix = component === undefined ? BASE_PREFIX : `${BASE_PREFIX}/${component}`;
  return { status: `${prefix}/status`, action: `${prefix}/action` };
}

/** Header carrying the per-process key on a state-changing request. */
export const KEY_HEADER = 'x-agent-bridge-key';

/** Host values that mean "this machine". */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Strip the optional `:port` from a Host header value, IPv6-bracket aware.
 *
 * @param {string} host
 * @returns {string}
 */
function hostnameOfHost(host) {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(':');
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon);
  }
  return hostname;
}

/**
 * Whether a request came from this machine.
 *
 * A browser always sends `Host`, so a missing or non-loopback one is refused.
 * `Origin` is checked only when present, because a non-browser caller — a test,
 * or the plugin's own tooling — sends none, and refusing those would break the
 * only way to verify the route without a page.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function loopbackRequest(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.trim() === '') return false;
  if (!LOOPBACK_HOSTS.has(hostnameOfHost(host))) return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.trim() === '') return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Write a JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body ?? null);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // The document describes live process state, so no cache may keep a copy.
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

/**
 * Read a request body, bounded.
 *
 * The only writes here are small JSON actions, so a body larger than this is not
 * a legitimate request. Reading without a bound would let one request hold the
 * socket until the harness gives up.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
function readJsonBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body is not JSON'));
      }
    });
  });
}

/**
 * Longest a status read waits for a catalogue that has never answered, in ms.
 *
 * A page that polls is the common caller, so this has to stay well under a
 * readable delay; the picker's own window is what the longer wait on an action
 * response is for.
 */
const STATUS_FIRST_CATALOG_MS = 1200;

/** Longest an action's answer waits for the catalogue of the vendor it touched. */
const ACTION_FIRST_CATALOG_MS = 4000;

/**
 * Mount the routes on the harness web server.
 *
 * Every instance serves one pair of routes per vendor it hosts — `/…/<vendor>/…`
 * — and, when it hosts more than one, the aggregate pair as well. The reason is
 * the page: a row's page addresses exactly one vendor, and a page that had to pick
 * its vendor out of a three-vendor document would be reading state it does not own.
 *
 * Registration is wrapped in `ctx.effect` so the routes leave with the plugin:
 * a plugin that is gone must not still describe a host.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{snapshot: (options?: {firstCatalogMs?: number, only?: string}) => Promise<Record<string, unknown>>, setEnabled: Function, uninstall: Function, restore: Function, refresh: Function, component?: string, components?: readonly string[]}} bridge
 * @param {{warn?: (message: string) => void, debug?: (message: string) => void}} [logger]
 */
export function registerRoutes(ctx, bridge, logger) {
  // A per-vendor instance addresses that one vendor, and a request naming another
  // is refused instead of silently retargeted.
  const own = typeof bridge.component === 'string' ? bridge.component : undefined;
  const hosted = Array.isArray(bridge.components) ? [...bridge.components] : [...COMPONENT_IDS];
  /** The pairs to mount: one per hosted vendor, plus the aggregate when there are several. */
  const mounts = hosted.map((id) => ({ id, paths: pathsFor(id) }));
  if (hosted.length > 1) mounts.push({ id: undefined, paths: pathsFor(undefined) });

  ctx.effect(() => {
    const disposers = mounts.map((mount) => mountPair(ctx, bridge, logger, mount));

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already gone */
        }
      }
    };
  }, 'dsh-agent-bridge: settings routes');
}

/**
 * Mount one status/action pair and return its disposer.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{snapshot: Function, setEnabled: Function, uninstall: Function, restore: Function, refresh: Function}} bridge
 * @param {{warn?: Function, debug?: Function} | undefined} logger
 * @param {{id: string | undefined, paths: {status: string, action: string}}} mount
 * @returns {() => void}
 */
function mountPair(ctx, bridge, logger, mount) {
  // The vendor a pair addresses, when the pair is a vendor's own.
  const own = mount.id;
  const paths = mount.paths;

  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    path: paths.status,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!loopbackRequest(req)) {
        sendJson(res, 403, { error: 'request-not-trusted' });
        return;
      }
      try {
        sendJson(
          res,
          200,
          await bridge.snapshot({ firstCatalogMs: STATUS_FIRST_CATALOG_MS, ...(own === undefined ? {} : { only: own }) })
        );
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  const disposeAction = ctx.webServer.register({
    kind: 'exact',
    path: paths.action,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!loopbackRequest(req)) {
        sendJson(res, 403, { error: 'request-not-trusted' });
        return;
      }
      // The status document's key is what proves this caller was handed the
      // page's own state, so an unkeyed POST is refused before its body is read.
      const key = req.headers[KEY_HEADER];
      const expected = (await bridge.snapshot()).key;
      if (typeof key !== 'string' || key !== expected) {
        sendJson(res, 403, { error: 'bad-key' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const action = /** @type {{action?: unknown, component?: unknown}} */ (body ?? {});
      const name = typeof action.action === 'string' ? action.action : '';
      const named = typeof action.component === 'string' ? action.component : '';
      if (own !== undefined && named !== '' && named !== own) {
        sendJson(res, 400, { error: `this route serves ${own}, not ${JSON.stringify(named)}` });
        return;
      }
      const component = own === undefined ? named : own;
      try {
        /** @type {{ok: boolean, reason?: string}} */
        let result;
        switch (name) {
          case 'enable':
            result = await bridge.setEnabled(component, true);
            break;
          case 'disable':
            result = await bridge.setEnabled(component, false);
            break;
          case 'uninstall':
            result = await bridge.uninstall(component);
            break;
          case 'restore':
            result = await bridge.restore(component);
            break;
          case 'refresh':
            result = await bridge.refresh(component);
            break;
          default:
            sendJson(res, 400, { error: `unknown action ${JSON.stringify(name)}` });
            return;
        }
        logger?.debug?.(`dsh-agent-bridge: ${name} ${component} → ok=${result.ok}`);
        // The answer carries the state the page will render next, so an `enable`
        // must not describe the vendor it just started as having no models.
        sendJson(res, 200, {
          ...result,
          status: await bridge.snapshot({
            firstCatalogMs: ACTION_FIRST_CATALOG_MS,
            ...(own === undefined ? {} : { only: own })
          })
        });
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  });

  return () => {
    try {
      disposeStatus();
    } catch {
      /* already gone */
    }
    try {
      disposeAction();
    } catch {
      /* already gone */
    }
  };
}
