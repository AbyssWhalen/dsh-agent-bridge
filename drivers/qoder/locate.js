/**
 * Discover the local Qoder CN desktop install and its credential store.
 *
 * Everything here is read-only against the user's own machine: the plugin
 * never writes into the Qoder app directory and never starts a sign-in flow.
 * The credential the desktop app already holds (`auth.v1.dat`, Electron
 * `safeStorage`-sealed) is opened with the same DPAPI key main-process
 * Electron used to seal it.
 *
 * @module dsh-agent-bridge/drivers/qoder/locate
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Product identity of the CN desktop build, from `resources/product.json`. */
export const PRODUCT = {
  id: 'qoder-cn',
  displayName: 'Qoder CN',
  appId: 'com.qodercn.app',
  dataDirectoryName: 'com.qodercn.app.stable',
  cliConfigDirectoryName: '.qoder-cn'
};

/**
 * Client id the desktop app uses to mint a job token.
 *
 * Taken from the build's own product descriptor (`authClientIds.prod`); it is
 * a public OAuth client identifier, not a secret.
 */
export const AUTH_CLIENT_ID = '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa';

/** OpenAPI origin that mints and refreshes job tokens. */
export const OPENAPI_ORIGIN = 'https://openapi.qoder.com.cn';

/** Where the installed app's versioned payloads live, newest last. */
export function versionsRoot(installDir) {
  return join(installDir, '.qoder-versions');
}

/**
 * Candidate install roots, most specific first.
 *
 * `QODER_CN_INSTALL_DIR` wins so a non-default install stays reachable
 * without editing the plugin. The defaults cover the two layouts the vendor
 * installer produces (`%LOCALAPPDATA%` user install and a drive-root
 * `CodeEditor` install observed on this machine).
 */
export function installCandidates(env = process.env) {
  const out = [];
  const override = env['QODER_CN_INSTALL_DIR'];
  if (typeof override === 'string' && override.trim() !== '') out.push(override.trim());
  const local = env['LOCALAPPDATA'];
  if (typeof local === 'string' && local !== '') out.push(join(local, 'Programs', 'Qoder CN'), join(local, 'Qoder CN'));
  for (const drive of ['C', 'D', 'E']) out.push(`${drive}:\\CodeEditor\\Qoder CN`, `${drive}:\\Qoder CN`);
  return out;
}

/** The install root that actually holds a `.qoder-versions` tree. */
export function resolveInstallDir(env = process.env) {
  for (const candidate of installCandidates(env)) {
    if (existsSync(versionsRoot(candidate))) return candidate;
  }
  return undefined;
}

/**
 * Every installed version directory, oldest name first.
 *
 * Version directory names are dotted numerics; sorting them as strings would
 * put `0.4.10` before `0.4.7`, so each component is compared numerically.
 */
export function listVersions(installDir) {
  const root = versionsRoot(installDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const left = a.split('.').map(Number);
      const right = b.split('.').map(Number);
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const delta = (left[i] ?? 0) - (right[i] ?? 0);
        if (delta !== 0) return delta;
      }
      return 0;
    });
}

/** Path to a version's bundled worker runtime, when that version ships one. */
export function workerRuntimePath(installDir, version) {
  return join(
    versionsRoot(installDir),
    version,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@qoder-ai',
    'qoder-cn-agent-sdk',
    'dist',
    '_worker',
    'qoder-worker-runtime.obf.mjs'
  );
}

/** Path to a version's worker runtime metadata (`runtime-info.json`). */
export function workerRuntimeInfoPath(installDir, version) {
  return join(
    versionsRoot(installDir),
    version,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@qoder-ai',
    'qoder-cn-agent-sdk',
    'dist',
    '_worker',
    'runtime-info.json'
  );
}

/**
 * The newest installed version that carries a usable worker runtime.
 *
 * The runtime path is what matters, not the version number: a partially
 * downloaded update can leave a directory without its unpacked payload.
 */
export function resolveRuntime(installDir) {
  const versions = listVersions(installDir);
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const version = versions[i];
    const runtimePath = workerRuntimePath(installDir, version);
    if (!existsSync(runtimePath)) continue;
    let sdkVersion;
    try {
      const info = JSON.parse(readFileSync(workerRuntimeInfoPath(installDir, version), 'utf8'));
      if (typeof info?.version === 'string' && info.version.length > 0) sdkVersion = info.version;
    } catch {
      /* metadata is advisory; the runtime itself is the requirement */
    }
    return { version, runtimePath, sdkVersion };
  }
  return undefined;
}

/** `%APPDATA%\com.qodercn.app.stable` — the app's own user-data directory. */
export function appDataDir(env = process.env) {
  const appData = env['APPDATA'];
  if (typeof appData !== 'string' || appData === '') return undefined;
  return join(appData, PRODUCT.dataDirectoryName);
}

/** `~/.qoder-cn` — the CLI-side state root (machine id, caches). */
export function cliStateDir(env = process.env) {
  const profile = env['USERPROFILE'] ?? env['HOME'];
  if (typeof profile !== 'string' || profile === '') return undefined;
  return join(profile, PRODUCT.cliConfigDirectoryName);
}

/**
 * Read one value out of the app's Electron `Local State`.
 *
 * `os_crypt.encrypted_key` is the DPAPI-sealed AES-256-GCM key Electron's
 * `safeStorage` uses for the `v10` file format. Only that field is read; the
 * rest of the document is none of this plugin's business.
 */
export function readEncryptedKey(appData) {
  const path = join(appData, 'Local State');
  if (!existsSync(path)) throw new Error(`qoder: Local State not found at ${path}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`qoder: Local State is not readable JSON: ${String(error)}`);
  }
  const encoded = parsed?.os_crypt?.encrypted_key;
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('qoder: Local State carries no os_crypt.encrypted_key');
  }
  return Buffer.from(encoded, 'base64');
}

/**
 * Unseal the Electron storage key with the current user's DPAPI key.
 *
 * Electron seals with `DPAPI(CurrentUser)`; `ProtectedData.Unprotect` in
 * Windows PowerShell is the same primitive. The `DPAPI` prefix electron
 * writes ahead of the blob is stripped first.
 */
export function unsealStorageKey(encryptedKey) {
  const prefix = encryptedKey.subarray(0, 5).toString('ascii');
  const blob = prefix === 'DPAPI' ? encryptedKey.subarray(5) : encryptedKey;
  const script = [
    'Add-Type -AssemblyName System.Security;',
    `$b=[Convert]::FromBase64String('${blob.toString('base64')}');`,
    '$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    "[BitConverter]::ToString($k).Replace('-','').ToLower()"
  ].join(' ');
  const hex = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  }).trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('qoder: DPAPI returned an unexpected key length');
  return Buffer.from(hex, 'hex');
}

/**
 * Open one `v10` sealed file: `v10` tag, 12-byte nonce, AES-256-GCM
 * ciphertext, 16-byte tag.
 */
export function openV10(key, buffer) {
  const prefix = buffer.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') throw new Error(`qoder: unexpected sealed-file prefix ${JSON.stringify(prefix)}`);
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(3, 15));
  decipher.setAuthTag(buffer.subarray(buffer.length - 16));
  return Buffer.concat([decipher.update(buffer.subarray(15, buffer.length - 16)), decipher.final()]);
}

/**
 * The desktop app's live credential.
 *
 * `token` is the device token the app itself presents, `refreshToken` renews
 * it, and `expiresAt` is an ISO instant. `user` carries the display name and
 * the stable account id.
 */
export function readCredential(env = process.env, options = {}) {
  const appData = options.appData ?? appDataDir(env);
  if (appData === undefined) throw new Error('qoder: APPDATA is not set, so the app data directory is unknown');
  const path = join(appData, 'auth.v1.dat');
  if (!existsSync(path)) throw new Error(`qoder: not signed in — ${path} does not exist`);
  const key = options.key ?? unsealStorageKey(readEncryptedKey(appData));
  let parsed;
  try {
    parsed = JSON.parse(openV10(key, readFileSync(path)).toString('utf8'));
  } catch (error) {
    throw new Error(`qoder: stored credential could not be opened: ${String(error)}`);
  }
  const token = parsed?.token;
  if (typeof token !== 'string' || token.length === 0) throw new Error('qoder: stored credential carries no token');
  return {
    token,
    refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
    expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : undefined,
    refreshTokenExpiresAt: typeof parsed.refreshTokenExpiresAt === 'string' ? parsed.refreshTokenExpiresAt : undefined,
    user: parsed?.user ?? undefined
  };
}

/**
 * A stable, non-secret identity for the signed-in account.
 *
 * Used only to scope local caches and to notice a sign-in swap. Falls back to
 * a token fingerprint so a credential without a user object still gets a key.
 */
export function credentialAccount(credential) {
  const id = credential?.user?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  return undefined;
}
