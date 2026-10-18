/**
 * Which vendors this plugin is currently serving, and why.
 *
 * The three vendors are independent products that happen to share one host. Each
 * one can stop being worth serving on its own schedule: a trial allowance runs
 * out, a vendor changes its protocol, an account is no longer needed. Making that
 * a per-vendor switch rather than an all-or-nothing uninstall is the whole point
 * of this module — turning one off must leave the other two untouched, and must
 * survive a restart so the choice sticks.
 *
 * Two distinct kinds of "off" are deliberate, because they mean different things
 * to a user looking at the list:
 *
 *   disabled   the driver is still on disk and can be switched back on at once
 *   removed    the driver's own files were moved out of the package; switching it
 *              back on means putting them back first
 *
 * Collapsing those into one flag would make "uninstall" a lie that a reinstall
 * silently undid. Keeping them apart also means the removal is reversible, which
 * is what makes it safe to offer at all.
 *
 * @module dsh-agent-bridge/state
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Vendors this plugin can serve, in the order the settings page lists them. */
export const COMPONENT_IDS = ['workbuddy', 'qoder'];

/**
 * The DSH home directory.
 *
 * Read from the environment first because that is what the running harness
 * itself uses, then from the platform default. The user's own home is the only
 * fallback that is right for both a packaged app and a checkout.
 *
 * @returns {string}
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/** This package's root, resolved from this module's own location. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Where the drivers live inside the package.
 *
 * `root` exists so a test can exercise park/restore against a scratch directory
 * instead of moving a real driver out of an installed package. Production callers
 * never pass it.
 *
 * @param {string} id
 * @param {string} [root]
 * @returns {string}
 */
export function driverDir(id, root = PACKAGE_ROOT) {
  return join(root, 'drivers', id);
}

/**
 * Where a removed driver's files are parked.
 *
 * Outside the package on purpose: pnpm owns `node_modules`, so anything left
 * inside a package directory can be replaced or pruned by the next install. A
 * removal the user asked for must not be undone by an unrelated `pnpm install`,
 * and a restore must still find the files afterwards.
 *
 * @returns {string}
 */
function removedRoot() {
  return join(dshHome(), 'agent-bridge-removed');
}

/** @returns {string} */
function statePath() {
  return join(dshHome(), 'agent-bridge-state.json');
}

/**
 * Whether a parsed value is a state document this reader can trust.
 *
 * Every field is checked rather than defaulted: a half-written or hand-edited
 * file must fall back to the built-in default, not put a `undefined` where the
 * mount loop expects a boolean. The default is "all on", which is what a fresh
 * install should do.
 *
 * @param {unknown} value
 * @returns {value is {version: number, disabled: string[], removed: string[]}}
 */
function isStateDocument(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const doc = /** @type {Record<string, unknown>} */ (value);
  if (doc.version !== 1) return false;
  const { disabled, removed } = doc;
  if (!Array.isArray(disabled) || !Array.isArray(removed)) return false;
  const isIdList = (list) => list.every((item) => typeof item === 'string' && item !== '');
  return isIdList(disabled) && isIdList(removed);
}

/** The state every install starts from. */
function defaultState() {
  return { version: 1, disabled: [], removed: [] };
}

/**
 * Read the saved state, falling back to the default.
 *
 * A missing file is the normal case on first run, so it is not an error. A file
 * that cannot be parsed is also not fatal: the plugin must still serve models
 * when its preference file is damaged, so the default wins and the damage is
 * reported through the returned note rather than thrown.
 *
 * @returns {{state: ReturnType<typeof defaultState>, note?: string}}
 */
export function readState() {
  const file = statePath();
  if (!existsSync(file)) return { state: defaultState() };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      state: defaultState(),
      note: `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!isStateDocument(parsed)) {
    return { state: defaultState(), note: `ignored an unreadable state document at ${file}` };
  }
  return {
    state: {
      version: 1,
      // Unknown ids are dropped rather than kept, so a state file written by a
      // later version cannot make this one believe it has a vendor it lacks.
      disabled: parsed.disabled.filter((id) => COMPONENT_IDS.includes(id)),
      removed: parsed.removed.filter((id) => COMPONENT_IDS.includes(id))
    }
  };
}

/**
 * Write the state atomically.
 *
 * A rename within one directory is atomic on every platform this runs on, so a
 * crash mid-write leaves the previous document rather than a truncated one — the
 * difference between "your switch did not save" and "the plugin lost its
 * preferences".
 *
 * @param {ReturnType<typeof defaultState>} state
 */
export function writeState(state) {
  const file = statePath();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/**
 * Whether a component is on, off, or gone.
 *
 * `removed` outranks `disabled`: a component whose files are not in the package
 * cannot run whatever the switch says, so reporting it as merely disabled would
 * describe a state the user cannot observe.
 *
 * @param {{disabled: string[], removed: string[]}} state
 * @param {string} id
 * @returns {'on' | 'off' | 'removed'}
 */
export function componentState(state, id) {
  if (state.removed.includes(id)) return 'removed';
  if (state.disabled.includes(id)) return 'off';
  return 'on';
}

/**
 * Move a directory, across volumes when it has to.
 *
 * `rename` is the right primitive — atomic, and it preserves the tree exactly —
 * but it only works within one filesystem. DSH's home and the profile are usually
 * on the same volume and sometimes are not, and an uninstall that silently failed
 * because of that would be worse than the extra copy. `EXDEV` is the one error
 * worth retrying, so it is the only one retried.
 *
 * @param {string} source
 * @param {string} target
 */
function moveDirectory(source, target) {
  try {
    renameSync(source, target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'EXDEV') throw error;
    cpSync(source, target, { recursive: true, preserveTimestamps: true });
    // Only after the copy has landed: removing first would lose the driver if the
    // copy failed halfway.
    rmSync(source, { recursive: true, force: true });
  }
}

/**
 * Move a driver's files out of the package.
 *
 * @param {string} id
 * @param {string} [root] Package root; tests pass a scratch directory.
 * @returns {{ok: true, parkedAt: string} | {ok: false, reason: string}}
 */
export function parkDriver(id, root = PACKAGE_ROOT) {
  const source = driverDir(id, root);
  if (!existsSync(source)) return { ok: false, reason: `drivers/${id} is already absent` };
  const parkedAt = join(removedRoot(), id);
  try {
    rmSync(parkedAt, { recursive: true, force: true });
    mkdirSync(dirname(parkedAt), { recursive: true });
    moveDirectory(source, parkedAt);
    return { ok: true, parkedAt };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Put a parked driver's files back.
 *
 * @param {string} id
 * @param {string} [root] Package root; tests pass a scratch directory.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function restoreDriver(id, root = PACKAGE_ROOT) {
  const parkedAt = join(removedRoot(), id);
  if (!existsSync(parkedAt)) return { ok: false, reason: `no parked copy of ${id} to restore` };
  const target = driverDir(id, root);
  try {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    moveDirectory(parkedAt, target);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether a parked copy of a driver exists, so the page can offer "restore".
 *
 * @param {string} id
 * @returns {boolean}
 */
export function hasParkedCopy(id) {
  return existsSync(join(removedRoot(), id));
}

/**
 * A stable key for this host process.
 *
 * The settings page can change state, and the status route is readable by any
 * same-origin page. The key is what separates "this page was handed the status
 * document by us" from "some page guessed the path" — the same seam the
 * WorkBuddy plugin uses, for the same reason.
 *
 * Computed once and cached: a key that changed between the status answer and the
 * action would make every click fail, so the randomness belongs to the process,
 * not to the call.
 *
 * @returns {string}
 */
export function hostKey() {
  if (cachedKey === undefined) {
    cachedKey = createHash('sha256')
      .update(`${process.pid}:${PACKAGE_ROOT}:${Math.random()}`)
      .digest('hex')
      .slice(0, 32);
  }
  return cachedKey;
}

/** @type {string | undefined} */
let cachedKey;
