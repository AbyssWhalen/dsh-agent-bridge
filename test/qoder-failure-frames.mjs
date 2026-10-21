/**
 * Offline: a failed turn is never reported as a successful empty one.
 *
 * The runtime reports a failure in more than one shape. For a model the account
 * does not have it sends
 *
 *     { type: 'result', subtype: 'error_during_execution', is_error: true,
 *       errors: ['Sorry, something went wrong. …'] }
 *
 * with **no `result` field**. The driver used to require a non-empty `result`
 * before calling a turn failed, so that frame read as a clean finish: the caller got
 * `finish: stop` with no text, no exception, and no log line — indistinguishable
 * from a model that simply declined to answer.
 *
 * The stand-in runtime here answers a prompt with whichever shape a test asks for,
 * so each is pinned without an account.
 *
 * Run with `node test/qoder-failure-frames.mjs`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'agent-bridge-frames-'));

/** Run one turn against a stand-in runtime that answers with `frame`. */
async function turnWith(frame, { textBefore = '' } = {}) {
  process.env.FAKE_RESULT_FRAME = JSON.stringify(frame);
  process.env.FAKE_RESULT_TEXT = textBefore;
  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-result-runtime.mjs', import.meta.url)),
    cwd: workDir,
    resolveCredential: async () => ({ token: 'unused', uid: 'test' }),
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });
  const chunks = [];
  let failure;
  let finish;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'Reply with exactly: PONG' }], {
      model: 'fake-model-1'
    })) {
      chunks.push(chunk.type);
      if (chunk.type === 'finish') finish = chunk.reason;
    }
  } catch (error) {
    failure = error;
  } finally {
    await conversation.close();
  }
  return { chunks, failure, finish };
}

try {
  console.log('\nan error with no `result` field (a rejected model)');
  {
    const { failure, finish } = await turnWith({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Sorry, something went wrong. Please try again. Report Issue (input /feedback)']
    });
    check('the turn throws', failure !== undefined, String(failure?.message));
    check('the reason from `errors` is carried', /something went wrong/u.test(String(failure?.message)), String(failure?.message));
    check('it does not finish as a normal stop', finish === undefined, JSON.stringify(finish ?? null));
  }

  console.log('\nan error with a `result` string');
  {
    const { failure, finish } = await turnWith({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'the model is unavailable'
    });
    check('the turn throws', failure !== undefined, String(failure?.message));
    check('the message is the runtime\'s own', /model is unavailable/u.test(String(failure?.message)), String(failure?.message));
    check('it does not finish as a normal stop', finish === undefined);
  }

  console.log('\na bare error with no detail at all');
  {
    const { failure } = await turnWith({ type: 'result', subtype: 'error_during_execution', is_error: true });
    check('the turn still throws', failure !== undefined);
    check('and names the subtype rather than saying nothing', /error_during_execution/u.test(String(failure?.message)), String(failure?.message));
  }

  console.log('\nafter text was already delivered, the turn is not retroactively failed');
  {
    const { failure, finish } = await turnWith(
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['late fault'] },
      { textBefore: 'PONG' }
    );
    check('no exception is raised', failure === undefined, String(failure?.message));
    check('the turn finishes normally', finish?.kind === 'stop', JSON.stringify(finish ?? null));
  }

  console.log('\na successful turn still finishes');
  {
    const { failure, finish, chunks } = await turnWith({ type: 'result', subtype: 'success', is_error: false }, {
      textBefore: 'PONG'
    });
    check('no exception is raised', failure === undefined);
    check('it finishes as a stop', finish?.kind === 'stop', JSON.stringify(finish ?? null));
    check('the text arrived', chunks.includes('text-delta'), JSON.stringify([...new Set(chunks)]));
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nqoder-failure-frames: ${failed.length === 0 ? 'OK' : `${failed.length} FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
