/**
 * A failed balance read must surface as a rejection.
 *
 * The catalog retains the last good figure for a bounded time when a quota reader
 * throws; that is what keeps a transient billing failure from blanking the
 * header. A driver that catches its own failure and returns `undefined` defeats
 * that path — the catalog sees a successful "no balance" answer and publishes it.
 *
 * Both drivers are checked here, so the contract is the same for each.
 */
import assert from 'node:assert/strict';

// Point WorkBuddy at a credential that cannot exist; no client is needed.
process.env.WORKBUDDY_AUTH_FILE = 'C:\\__dsh_agent_bridge_no_such_credential__';

const { driver: workbuddy } = await import('../drivers/workbuddy/index.js');
const { driver: qoder } = await import('../drivers/qoder/index.js');

await assert.rejects(
  () => workbuddy.quota({ fresh: true }),
  (error) => error instanceof Error && error.message.length > 0,
  'workbuddy: a failed balance read must reject instead of reading as empty'
);

// Qoder uses the global fetch for the quota call; make it fail without a network.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('offline');
};
try {
  await assert.rejects(
    () => qoder.quota(),
    (error) => error instanceof Error && error.message.length > 0,
    'qoder: a failed balance read must reject instead of reading as empty'
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log('# quota-failure: OK');
