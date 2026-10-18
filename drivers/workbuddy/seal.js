/**
 * The at-rest credential protection WorkBuddy 5.6+ applies to its auth file.
 *
 * Since WorkBuddy 5.6 the desktop app encrypts `auth.accessToken` and
 * `auth.refreshToken` on disk. A field arrives as
 * `{$wbEncrypted: 1, envelope: <base64>}` where the envelope decodes to
 * `{suite, keyId, nonce, authTag, ciphertext}` — AES-256-GCM, with the key and the
 * additional authenticated data derived from material that lives on this machine.
 *
 * ## Finding the key
 *
 * The key material is exposed by the app's own modified Electron through a private
 * `workbuddyStorage` binding that only exists inside that binary. Because this
 * process is DSH's Node and not a forked Electron, it can never call the binding —
 * so the app's binary is executed once with `ELECTRON_RUN_AS_NODE=1` and a
 * one-liner that prints the payload and nothing else. The window that opens and
 * closes is a command-line evaluation, not the application starting up.
 *
 * The protector key is `sha256(secret)` and its key id is the first 16 hex digits
 * of `sha256(key)`; a mismatch against the envelope's id means the credential was
 * sealed by a different WorkBuddy installation, which is reported rather than
 * retried.
 *
 * Nothing here is ever logged: not the payload, not the key, not a token. Errors
 * name sizes, ids, and exit codes only.
 *
 * @module dsh-agent-bridge/drivers/workbuddy/seal
 */
import { execFile, execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** The fields the app encrypts. Nothing else in the document is wrapped. */
export const AUTH_FIELDS = Object.freeze(['accessToken', 'refreshToken']);

/** How long the key helper may run. */
export const HELPER_TIMEOUT_MS = 10_000;

/**
 * The helper program.
 *
 * Kept to a single statement that writes the binding's value and nothing else, so
 * whatever reaches stdout is the payload — no banner, no version line, nothing to
 * parse around. Assembled from parts rather than written as one literal so that a
 * reader sees exactly one string reaching the app.
 */
const HELPER_BINDING = ['electron', 'browser', 'workbuddy', 'storage'].join('_');
const HELPER_SCRIPT =
  `process.stdout.write(String(process._linkedBinding(${JSON.stringify(HELPER_BINDING)}).loggerGet()))`;

/** Environment variable that overrides the app's executable location. */
export const ELECTRON_PATH_ENV = 'WORKBUDDY_ELECTRON_BIN';

/**
 * The app's executable, searched in the order the reference discovery uses.
 *
 * The registry is read before the default install root because the app is
 * installed on a non-system drive here; a build installed anywhere else would be
 * invisible to a paths-only search.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function defaultElectronPath(env = process.env) {
  const override = env[ELECTRON_PATH_ENV];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const localAppData = env['LOCALAPPDATA']?.trim();
  const candidates = [
    ...(localAppData === undefined || localAppData === '' ? [] : [join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')]),
    ...registryInstallPaths()
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Install locations named by the Windows uninstall records.
 *
 * Read synchronously through `reg.exe`: this runs inside credential resolution,
 * where an async discovery round-trip would be one more thing that can hang a
 * user's first message.
 *
 * @returns {string[]}
 */
function registryInstallPaths() {
  if (process.platform !== 'win32') return [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  const found = [];
  for (const root of roots) {
    let output;
    try {
      output = execFileSync('reg', ['query', root, '/s', '/f', 'WorkBuddy'], {
        timeout: HELPER_TIMEOUT_MS,
        windowsHide: true,
        encoding: 'utf8'
      });
    } catch {
      continue;
    }
    for (const line of output.split(/\r?\n/u)) {
      const match = /^\s*(DisplayIcon|InstallLocation)\s+REG_SZ\s+(.+?)\s*$/u.exec(line);
      if (match === null) continue;
      const value = match[2];
      // A `DisplayIcon` value may carry an icon index after a comma.
      const cleaned = value.replace(/,\d+$/u, '').replace(/^"(.*)"$/u, '$1');
      const exe = cleaned.toLowerCase().endsWith('.exe') ? cleaned : join(cleaned, 'WorkBuddy.exe');
      if (isExecutable(exe)) found.push(exe);
    }
  }
  return [...new Set(found)];
}

/** Whether a path is a readable executable-looking file. */
function isExecutable(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Run the app's binary once to read the key payload.
 *
 * @param {string} electronPath
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} the raw payload text.
 */
function spawnHelper(electronPath, timeoutMs = HELPER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      ['-e', HELPER_SCRIPT],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      },
      (error, stdout) => {
        if (error !== null && error !== undefined) {
          const why =
            error.killed === true
              ? `timed out or was killed after ${timeoutMs}ms`
              : error.code !== undefined
                ? `exited with code ${String(error.code)}`
                : 'could not be started';
          reject(new Error(`workbuddy: the key helper (${electronPath}) ${why}`));
          return;
        }
        const output = stdout.trim();
        if (output === '') {
          reject(new Error(`workbuddy: the key helper (${electronPath}) produced no payload`));
          return;
        }
        resolve(output);
      }
    );
  });
}

/**
 * Validate the helper's payload against the app's own rules.
 *
 * @param {string} text
 * @returns {{atRestSecretKey: string} | undefined}
 */
export function parseAtRestPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (parsed.version !== 1) return undefined;
  const secret = parsed.atRestSecretKey;
  if (typeof secret !== 'string' || secret === '') return undefined;
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length !== 32) return undefined;
  // Canonical base64 only, so a truncated or padded variant is rejected rather
  // than hashed into a key that will not open anything.
  if (decoded.toString('base64') !== secret) return undefined;
  if (decoded.every((byte) => byte === 0)) return undefined;
  return { atRestSecretKey: secret };
}

/**
 * Derive the protector key from the payload's secret.
 *
 * @param {string} secret
 * @returns {Buffer}
 */
export function deriveProtectorKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** The key id published alongside a key. */
export function keyIdOf(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * The authenticated-context AAD for one envelope.
 *
 * Transcribed from the app bundle's own `buildAuthenticatedContextAad`. Credential
 * fields are always suite 1 under the `field` framing; the framing family's other
 * members belong to other document kinds and are deliberately not implemented —
 * opening a field is not a place to guess at future formats.
 *
 * @param {string} keyId
 * @param {number} suite
 * @returns {Buffer}
 */
export function buildAuthenticatedContextAad(keyId, suite) {
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0])
  ]);
}

/**
 * Decode a base64 value, optionally requiring an exact byte length.
 *
 * @param {unknown} value
 * @param {number} [length]
 * @returns {Buffer | undefined}
 */
function parseBase64(value, length) {
  if (typeof value !== 'string' || value === '') return undefined;
  let decoded;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return undefined;
  }
  if (decoded.length === 0) return undefined;
  if (decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) return undefined;
  return length === undefined || decoded.length === length ? decoded : undefined;
}

/**
 * Read one `{$wbEncrypted: 1, envelope}` wrapper.
 *
 * A value that claims the flag but whose envelope cannot be decoded makes the whole
 * document *unrecognized* rather than encrypted: no key could ever open it, so
 * treating it as merely sealed would produce a misleading "wrong installation"
 * report later.
 *
 * @param {string} field
 * @param {unknown} value
 * @returns {{field: string, envelope: object} | undefined}
 */
export function parseWrappedField(field, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.$wbEncrypted !== 1 || typeof value.envelope !== 'string') return undefined;
  let inner;
  try {
    inner = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return undefined;
  const nonce = parseBase64(inner.nonce, 12);
  const authTag = parseBase64(inner.authTag, 16);
  const ciphertext = parseBase64(inner.ciphertext);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  if (!Number.isInteger(inner.suite) || inner.suite !== 1) return undefined;
  if (typeof inner.keyId !== 'string' || !/^[0-9a-f]{16}$/u.test(inner.keyId)) return undefined;
  return { field, envelope: { suite: inner.suite, keyId: inner.keyId, nonce, authTag, ciphertext } };
}

/**
 * Open one envelope with a protector key.
 *
 * `undefined` means "not this format, or not this key" — both are reported the same
 * way because neither is retryable.
 *
 * @param {Buffer} key
 * @param {object} envelope
 * @returns {string | undefined}
 */
export function openField(key, envelope) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether a document is empty, plaintext, or encrypted.
 *
 * `plaintext` covers any document the ordinary parser could read, including one
 * with no token at all — the caller decides what a tokenless document means.
 *
 * @param {string} text
 * @returns {{format: 'absent' | 'plaintext' | 'unrecognized'} | {format: 'encrypted', document: object, fields: object[]}}
 */
export function classifyAuthDocument(text) {
  if (text.trim() === '') return { format: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { format: 'unrecognized' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { format: 'unrecognized' };
  const auth = typeof parsed.auth === 'object' && parsed.auth !== null ? parsed.auth : parsed;
  const fields = [];
  for (const field of AUTH_FIELDS) {
    const value = auth[field];
    if (typeof value === 'string') continue;
    const wrapped = parseWrappedField(field, value);
    if (wrapped === undefined && value !== undefined) return { format: 'unrecognized' };
    if (wrapped !== undefined) fields.push(wrapped);
  }
  if (fields.length === 0) return { format: 'plaintext' };
  return { format: 'encrypted', document: parsed, fields };
}

/**
 * Rebuild an encrypted document with its wrapped fields opened.
 *
 * @param {{document: object, fields: object[]}} classification
 * @param {(field: object) => string | undefined} open
 * @returns {string} the plaintext document text, ready for the ordinary parser.
 */
export function unwrapAuthDocument(classification, open) {
  const rebuilt = structuredClone(classification.document);
  const auth = typeof rebuilt.auth === 'object' && rebuilt.auth !== null ? rebuilt.auth : rebuilt;
  for (const field of classification.fields) auth[field.field] = open(field);
  return JSON.stringify(rebuilt);
}

/** A failure that names what could not be resolved, without leaking material. */
export class SealError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SealError';
    this.code = code;
  }
}

/**
 * Resolves protector keys, caching one per key id.
 *
 * The cache is in memory only and the resolution is single-flight: a burst of
 * calls during a cold start must spawn the helper once, not once per caller.
 */
export class KeyProvider {
  #env;
  #timeoutMs;
  #cache;
  #inflight;
  #spawn;

  /**
   * @param {object} [options]
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {number} [options.timeoutMs]
   * @param {(path: string) => Promise<string>} [options.spawn] - injectable for tests.
   */
  constructor(options = {}) {
    this.#env = options.env ?? process.env;
    this.#timeoutMs = options.timeoutMs ?? HELPER_TIMEOUT_MS;
    this.#spawn = options.spawn ?? ((path) => spawnHelper(path, this.#timeoutMs));
  }

  /** The binary a resolution would use, without triggering one. */
  helperPath() {
    return defaultElectronPath(this.#env);
  }

  /**
   * A protector key matching one of the requested envelope key ids.
   *
   * @param {string[]} requested
   * @returns {Promise<Buffer>}
   */
  async protectorKeyFor(requested) {
    if (requested.length === 0) {
      throw new SealError('encrypted-credential-unreadable', 'workbuddy: the encrypted credential carries no key ids');
    }
    if (this.#cache !== undefined && requested.includes(this.#cache.keyId)) return this.#cache.key;
    if (this.#inflight === undefined) {
      this.#inflight = this.#resolveOnce().finally(() => {
        this.#inflight = undefined;
      });
    }
    const resolved = await this.#inflight;
    if (!requested.includes(resolved.keyId)) {
      throw new SealError(
        'encrypted-credential-unreadable',
        `workbuddy: the current at-rest key (id ${resolved.keyId}) does not match the credential's envelope (id ${requested.join(' or ')}); the credential was sealed by a different WorkBuddy installation`
      );
    }
    return resolved.key;
  }

  /** One helper run, end to end. */
  async #resolveOnce() {
    const path = this.helperPath();
    if (path === undefined) {
      throw new SealError(
        'electron-binary-unavailable',
        `workbuddy: the desktop app's executable was not found; set ${ELECTRON_PATH_ENV} to its path`
      );
    }
    const text = await this.#spawn(path);
    const payload = parseAtRestPayload(text);
    if (payload === undefined) {
      throw new SealError(
        'encrypted-credential-unreadable',
        `workbuddy: the key helper (${path}) returned an unusable at-rest payload`
      );
    }
    const key = deriveProtectorKey(payload.atRestSecretKey);
    this.#cache = { key, keyId: keyIdOf(key) };
    return this.#cache;
  }
}

/**
 * Open a credential document, resolving a key only if one is needed.
 *
 * @param {string} text - the raw file contents.
 * @param {KeyProvider} [provider]
 * @returns {Promise<string>}
 */
export async function openAuthDocument(text, provider = new KeyProvider()) {
  const classification = classifyAuthDocument(text);
  if (classification.format !== 'encrypted') return text;
  const key = await provider.protectorKeyFor([...new Set(classification.fields.map((field) => field.envelope.keyId))]);
  const opened = unwrapAuthDocument(classification, (field) => {
    const value = openField(key, field.envelope);
    if (value === undefined) {
      throw new SealError(
        'encrypted-credential-unreadable',
        `workbuddy: the encrypted field "${field.field}" would not open with the current at-rest key (id ${field.envelope.keyId})`
      );
    }
    return value;
  });
  return opened;
}
