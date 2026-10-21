/**
 * Offline: a Qoder turn whose caller is already gone is never sent.
 *
 * Failing the stream queue was not enough. The prompt was written to the worker
 * child before the queue was drained, so a turn the caller had cancelled still
 * went upstream: it spent the account's credit, and it left the child's history one
 * exchange longer than the class tracking that history believed. The next turn then
 * either replayed a conversation the child already had or lost append detection.
 *
 * The stand-in runtime logs every line it receives, so "was a prompt sent" is
 * observable without an account.
 *
 * Run with `node test/qoder-cancel.mjs`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'agent-bridge-cancel-'));
const logFile = join(workDir, 'runtime.log');
process.env.FAKE_RUNTIME_LOG = logFile;
process.env.FAKE_MODELS_FIRST = '1';

/** The lines the stand-in runtime received, filtered by shape. */
function received(kind) {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith(kind));
  } catch {
    return [];
  }
}

const conversation = new QoderConversation({
  runtimePath: fileURLToPath(new URL('./fake-qoder-runtime.mjs', import.meta.url)),
  cwd: workDir,
  resolveCredential: async () => ({ token: 'unused', uid: 'test' }),
  logger: { debug: () => {}, info: () => {}, warn: () => {} }
});

try {
  // Warm the child so the cancellation is the only thing this case measures.
  const models = await conversation.listModels();
  check('the stand-in runtime answers', models.length === 1, `${models.length} model(s)`);

  const controller = new AbortController();
  controller.abort();

  const chunks = [];
  let failure;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'Reply with exactly: PONG' }], {
      model: 'fake-model-1',
      signal: controller.signal
    })) {
      chunks.push(chunk);
    }
  } catch (error) {
    failure = error;
  }

  check('the turn throws', failure !== undefined, String(failure?.message));
  check('the error names itself a cancellation', failure?.name === 'AbortError', String(failure?.name));
  check('it says cancelled, not rejected', /cancel/u.test(String(failure?.message)), String(failure?.message));
  check('no chunk was produced', chunks.length === 0, `${chunks.length} chunk(s)`);
  check(
    'no prompt reached the worker child',
    received('user').length === 0,
    `${received('user').length} prompt(s)`
  );
  check(
    'the runtime was not asked to interrupt a turn that never started',
    received('interrupt').length === 0,
    `${received('interrupt').length} interrupt(s)`
  );
} finally {
  await conversation.close();
  rmSync(workDir, { recursive: true, force: true });
}

// A cancellation that lands mid-turn must still reach the child as an interrupt.
console.log('\nmid-turn cancellation still interrupts');
{
  const workDir2 = mkdtempSync(join(tmpdir(), 'agent-bridge-cancel2-'));
  const logFile2 = join(workDir2, 'runtime.log');
  process.env.FAKE_RUNTIME_LOG = logFile2;
  const chat = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-slow-runtime.mjs', import.meta.url)),
    cwd: workDir2,
    resolveCredential: async () => ({ token: 'unused', uid: 'test' }),
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });
  const controller = new AbortController();
  let failure;
  const reader = (async () => {
    try {
      for await (const chunk of chat.send([{ role: 'user', text: 'hi' }], { model: 'm', signal: controller.signal })) {
        void chunk;
      }
    } catch (error) {
      failure = error;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 250));
  controller.abort();
  await reader;
  // The interrupt frame is written synchronously but read by the child
  // asynchronously, so the log is given a moment to reflect it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const lines = (() => {
    try {
      return readFileSync(logFile2, 'utf8');
    } catch {
      return '';
    }
  })();
  check('the mid-turn cancellation throws a cancellation', failure?.name === 'AbortError', String(failure?.message));
  check('the prompt had been sent by then', lines.includes('user'), 'prompt seen');
  check('the child was asked to interrupt', lines.includes('interrupt'), 'interrupt seen');
  await chat.close();
  rmSync(workDir2, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nqoder-cancel: ${failed.length === 0 ? 'OK' : `${failed.length} FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
