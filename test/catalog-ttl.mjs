/**
 * Offline: a Qoder catalog is reused while it is fresh, and re-read once it is not.
 *
 * The shipped code cached the first non-empty listing for the life of the worker
 * process and never asked again, so a model the account had gained or lost was
 * reported wrong until DSH restarted. `docs/verification.md` described that failure
 * and a fix that was never in the code, so this test pins the behaviour rather than
 * the write-up.
 *
 * No Qoder install is involved: the session is pointed at a stand-in runtime that
 * grows its roster on every listing, which makes a re-read visible as a number.
 *
 * Run with `node test/catalog-ttl.mjs`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const runtimePath = fileURLToPath(new URL('./fake-qoder-runtime.mjs', import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), 'agent-bridge-ttl-'));
const logFile = join(workDir, 'runtime.log');

process.env.FAKE_MODELS_FIRST = '1';
process.env.FAKE_RUNTIME_LOG = logFile;

const TTL_MS = 250;
const conversation = new QoderConversation({
  runtimePath,
  cwd: workDir,
  resolveCredential: async () => ({ token: 'unused', uid: 'test' }),
  catalogTtlMs: TTL_MS,
  logger: { debug: () => {}, info: () => {}, warn: () => {} }
});

/** How many `get_models` requests the stand-in runtime has answered. */
function listingCalls() {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim() === 'control_request:get_models').length;
  } catch {
    return 0;
  }
}

try {
  const first = await conversation.listModels();
  check('the first listing is what upstream reported', first.length === 1, `${first.length} model(s)`);
  check('it was fetched, not served from a cache', listingCalls() === 1, `${listingCalls()} call(s)`);

  const again = await conversation.listModels();
  check(
    'a listing inside the TTL is served from the cache',
    again === first && listingCalls() === 1,
    `${listingCalls()} call(s), same array: ${again === first}`
  );

  await new Promise((resolve) => setTimeout(resolve, TTL_MS + 150));

  const expired = await conversation.listModels();
  check(
    'a listing past the TTL asks the runtime again',
    expired !== first && listingCalls() === 2,
    `${listingCalls()} call(s), same array: ${expired === first}`
  );
  check(
    'and the re-read answer is the new one, not the old roster',
    expired.length === 2,
    `${expired.length} model(s)`
  );

  // An empty listing must never be cached: it is how a signed-out account hides the
  // provider, so the next refresh has to look again.
  const emptyRuntime = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-empty-runtime.mjs', import.meta.url)),
    cwd: workDir,
    resolveCredential: async () => ({ token: 'unused', uid: 'test' }),
    catalogTtlMs: TTL_MS,
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });
  const emptyFirst = await emptyRuntime.listModels();
  const emptySecond = await emptyRuntime.listModels();
  check('an empty listing is not cached', emptyFirst.length === 0 && emptySecond.length === 0);
  await emptyRuntime.close();
} finally {
  await conversation.close();
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\ncatalog-ttl: ${failed.length === 0 ? 'OK' : `${failed.length} FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
