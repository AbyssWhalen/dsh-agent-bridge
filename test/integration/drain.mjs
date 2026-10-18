/**
 * Does the plugin let its host exit on its own?
 *
 * Every other probe in this directory ends in `process.exit(...)`, which is exactly
 * the thing that would hide this question: a host does not call `process.exit` after
 * a task, it stops working and waits for the event loop to drain. So a plugin that
 * leaves a handle open is invisible to a test that forces the exit, and shows up
 * only here — as a process that finished its work and then sat there.
 *
 * The probe boots the plugin against a stand-in context, runs one real turn, runs
 * the teardown the host would run, and then simply stops. If the loop is clean the
 * process ends by itself; if it is not, a timer reports what is still holding it.
 *
 * Usage: node _scratch/integration/drain.mjs <driver-id> [seconds]
 */
import { Catalog, CATALOG_REFRESH_MS, CATALOG_RETRY_MS } from '../../lib/catalog.js';
import { DriverAdapter } from '../../lib/adapter.js';
import { toCatalogRow } from '../../lib/driver.js';

const [id, secondsArg] = process.argv.slice(2);
const budget = Number(secondsArg ?? 30) * 1000;
if (typeof id !== 'string' || id === '') {
  console.error('usage: node drain.mjs <driver-id> [seconds]');
  process.exit(2);
}

const children = () => (process._getActiveHandles?.() ?? []).filter((handle) => handle?.constructor?.name === 'ChildProcess');
const started = Date.now();

const { driver } = await import(`../../drivers/${id}/index.js`);
const catalog = new Catalog({
  listModels: () => driver.listModels(),
  normalize: (raw) => toCatalogRow(driver.normalize(raw)),
  quota: driver.quota === undefined ? undefined : () => driver.quota(),
  label: id
});
const adapter = new DriverAdapter({ provider: id, displayName: driver.displayName, driver, catalog });
const stop = catalog.start({ intervalMs: CATALOG_REFRESH_MS, retryMs: CATALOG_RETRY_MS });

await catalog.whenReady(30_000);
const row = catalog.current()[0];

// The turn runs inside `try`, because a failed turn must not skip the teardown
// below it. It did once: a transient upstream 504 threw out of the `for await`,
// the cleanup never ran, the child stayed open, and the probe blamed the plugin
// for a hang the plugin had nothing to do with. A probe that can report a false
// failure is worse than no probe.
try {
  if (row !== undefined) {
    for await (const chunk of adapter.stream({
      sessionId: 'drain-probe',
      model: row.id,
      messages: [{ role: 'user', content: 'Reply with the single word PONG.' }]
    })) {
      if (chunk.type === 'finish') break;
    }
  }
} catch (error) {
  console.log(`${id}: the turn failed (${String(error).slice(0, 120)}); checking the loop anyway`);
} finally {
  // Exactly what lib/index.js does on dispose.
  stop();
  await adapter.close();
}

const elapsed = Date.now() - started;
console.log(`${id}: work done in ${(elapsed / 1000).toFixed(1)}s; children held: ${children().length}`);
console.log(`${id}: nothing more to do — if the process exits now, the loop is clean`);

// Note for whoever reads a "STILL ALIVE" line: that is not necessarily this driver's
// fault. The DSH headless CLI does not exit on its own in this environment even when
// the turn fails before any plugin is reached — measured with a provider that does
// not exist, which fails with NO_ADAPTER and then sits there exactly the same way.
// The two things this probe can honestly distinguish are "the loop is clean after a
// real teardown" and "it is not", which is why `adapter.close()` is called above
// rather than leaving the host to do it.

// A watchdog only fires if the loop is still busy. Its presence is diagnostic and
// it must not itself keep the process alive, so it is cleared as soon as it runs.
const watchdog = setTimeout(() => {
  console.log(`\n${id}: STILL ALIVE ${(budget / 1000).toFixed(0)}s after the work finished.`);
  console.log(`  active handles: ${(process._getActiveHandles?.() ?? []).map((h) => h?.constructor?.name).join(', ') || 'none'}`);
  for (const child of children()) console.log(`  child pid ${child.pid} still running`);
  process.exitCode = 1;
  process.exit(1);
}, budget);
watchdog.unref();
