/**
 * Teardown test through the real turn path: open a conversation, stream a turn,
 * close the adapter, and check that no child process survives.
 *
 * Listing models only exercises the catalogue's own child. A turn opens a *pooled*
 * conversation, which is a second child, and that is the one the host's shutdown
 * has to reach. A lingering child after a turn is the visible symptom of a
 * teardown that stops one step short.
 *
 * Usage: node _scratch/integration/turn-teardown.mjs <driver-id> [model]
 */
import { Catalog, CATALOG_REFRESH_MS, CATALOG_RETRY_MS } from '../../lib/catalog.js';
import { DriverAdapter } from '../../lib/adapter.js';
import { toCatalogRow } from '../../lib/driver.js';

const [id, modelArg] = process.argv.slice(2);
if (typeof id !== 'string' || id === '') {
  console.error('usage: node turn-teardown.mjs <driver-id> [model]');
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
const row = catalog.current().find((entry) => entry.id === modelArg) ?? catalog.current()[0];
if (row === undefined) {
  console.log(`${id}: no models, nothing to stream`);
  stop();
  await adapter.close();
  process.exit(0);
}
console.log(`${id}: streaming with model ${row.id}`);

let text = '';
const seen = new Set();
try {
  for await (const chunk of adapter.stream({
    sessionId: 'teardown-probe',
    model: row.id,
    messages: [{ role: 'user', content: 'Reply with exactly the word PONG and nothing else.' }]
  })) {
    seen.add(chunk.type);
    if (chunk.type === 'text-delta') text += chunk.text;
  }
} catch (error) {
  console.log(`  stream failed: ${error.message.slice(0, 160)}`);
}
console.log(`  chunk types: ${[...seen].join(', ')}`);
console.log(`  text: ${JSON.stringify(text)}`);
console.log(`  children before close: ${children().map((child) => child.pid).join(', ') || 'none'}`);

stop();
await adapter.close();
await new Promise((resolve) => setTimeout(resolve, 2000));

const after = children();
console.log(`  children after close: ${after.map((child) => child.pid).join(', ') || 'none'}`);
console.log(`  ${after.length === 0 ? 'NO LEAK' : 'LEAK'}`);
process.exit(after.length === 0 ? 0 : 1);
