/**
 * Teardown test for one driver: does `close()` leave a child process behind?
 *
 * A lingering child is the clearest sign a driver keeps a resource outside the
 * session pool that teardown never reaches — a catalogue worker, a warm
 * conversation, a helper. The host integration test can only say "something
 * leaked"; this says which one.
 *
 * Usage: node _scratch/integration/leak.mjs <driver-id>
 */
import { Catalog, CATALOG_REFRESH_MS, CATALOG_RETRY_MS } from '../../lib/catalog.js';
import { DriverAdapter } from '../../lib/adapter.js';
import { toCatalogRow } from '../../lib/driver.js';

const id = process.argv[2];
if (typeof id !== 'string' || id === '') {
  console.error('usage: node leak.mjs <driver-id>');
  process.exit(2);
}

const children = () => (process._getActiveHandles?.() ?? []).filter((handle) => handle?.constructor?.name === 'ChildProcess');

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
console.log(`${id}: ${catalog.status.models} model(s), quota=${catalog.status.hasQuota}`);
console.log(`  children during listing: ${children().map((child) => child.pid).join(', ') || 'none'}`);

stop();
await adapter.close();
// Give a killed child a moment to be reaped before deciding.
await new Promise((resolve) => setTimeout(resolve, 1500));

const after = children();
console.log(`  children after close: ${after.map((child) => child.pid).join(', ') || 'none'}`);
console.log(`  ${after.length === 0 ? 'NO LEAK' : 'LEAK'}`);
process.exit(after.length === 0 ? 0 : 1);
