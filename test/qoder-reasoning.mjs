/**
 * The reasoning channel's own markup guard.
 *
 * The text channel has held call markup since the first leak report: `hasNativeLeak` starts a
 * hold, and a parser decides when the block has ended. Reasoning had neither. It stripped
 * every delta the moment `hasLeak` turned true and then cleared the buffer, which is correct
 * only when the whole block arrives in one piece. Streamed, the first delta that trips the
 * check carries just the opening of the block: the strip deletes that opening, and the rest
 * of the block arrives afterwards with no recognisable open tag, so it is released as
 * ordinary reasoning text — `｜｜invoke name="pwsh">｜｜parameter name="command">Get-Date`
 * in the thinking pane.
 *
 * Measured through the real conversation object with one-character deltas: five of nine
 * shapes leaked before the hold, none after. This file pins all nine, because the batch
 * parser is green in every one of them — only the split exposes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QoderConversation } from '../drivers/qoder/conversation.js';
import { hasUnclosedCallMarkup } from '../lib/dsml.js';

const B = '\uFF5C';
const scratch = mkdtempSync(join(tmpdir(), 'dsh-reasoning-'));

/** Anything that came from the wire format rather than from the model's own words. */
const MARKUP = /[｜|]{2}|DSML|invoke|parameter|function_call/iu;

/**
 * Run one turn whose deltas are thinking deltas, and report each channel separately.
 *
 * @param {string[]} deltas
 * @param {boolean} [split] - cut the joined script into single characters.
 */
async function think(deltas, split = false) {
  const file = join(scratch, `d-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(deltas));
  process.env.FAKE_DELTAS_FILE = file;
  process.env.FAKE_THINKING = '1';
  if (split) process.env.FAKE_SPLIT = '1';
  else delete process.env.FAKE_SPLIT;

  const conversation = new QoderConversation({
    runtimePath: fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url)),
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, info() {}, warn() {} }
  });

  const chunks = [];
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model-1', effort: 'low' })) {
      chunks.push(chunk);
    }
  } catch (error) {
    chunks.push({ type: 'error', error });
  } finally {
    await conversation.close();
    delete process.env.FAKE_SPLIT;
    delete process.env.FAKE_THINKING;
  }

  return {
    reasoning: chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join(''),
    text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  };
}

test.after(() => rmSync(scratch, { recursive: true, force: true }));

const NATIVE = `<${B}${B}DSML${B}${B}invoke name="pwsh"><${B}${B}DSML${B}${B}parameter name="command">Get-Date</${B}${B}DSML${B}${B}parameter></${B}${B}DSML${B}${B}invoke>`;
const BARE = '<invoke name="pwsh"><parameter name="command">Get-Date</parameter></invoke>';

test('a call block never reaches the reasoning channel, however it is split', async () => {
  const shapes = {
    'native, one delta': [[NATIVE], false],
    'native, one character at a time': [[NATIVE], true],
    'native, split inside the opening': [[NATIVE.slice(0, 7), NATIVE.slice(7)], false],
    'native, split after the opening tag': [[NATIVE.slice(0, 28), NATIVE.slice(28)], false],
    'bare, one delta': [[BARE], false],
    'bare, one character at a time': [[BARE], true],
    'bare, split after the opener': [[BARE.slice(0, 21), BARE.slice(21)], false],
    'an opener that never closes': [[`<${B}${B}DSML${B}${B}invoke name="pwsh">`], false],
    'half a delimiter at the end': [[`${NATIVE}${B}`], false]
  };

  const failures = [];
  for (const [label, [deltas, split]] of Object.entries(shapes)) {
    const { reasoning } = await think(deltas, split);
    if (MARKUP.test(reasoning)) failures.push(`${label} -> ${JSON.stringify(reasoning.slice(0, 80))}`);
  }
  assert.deepEqual(failures, [], `markup reached the reasoning channel:\n${failures.join('\n')}`);
});

test('the prose around a block still arrives', async () => {
  // Holding must not become swallowing: the sentence the model wrote before reaching for a
  // tool is the part a reader can use.
  for (const split of [false, true]) {
    const { reasoning } = await think([`Let me think about this. ${NATIVE}`], split);
    assert.match(reasoning, /Let me think about this/u, `prose lost (split=${split}): ${JSON.stringify(reasoning)}`);
    assert.equal(MARKUP.test(reasoning), false, `markup leaked (split=${split})`);
  }
});

test('ordinary reasoning is not delayed by the guard', async () => {
  // The hold has to be narrow. A model that thinks in plain prose must reach the reader
  // unchanged, including when the thought is streamed one character at a time.
  const plain = 'The build failed because two workers wrote the same file.';
  for (const split of [false, true]) {
    const { reasoning } = await think([plain], split);
    assert.equal(reasoning, plain, `ordinary reasoning was altered (split=${split})`);
  }
});

test('a reasoning block left open at the end of a turn is still shown, without its markup', async () => {
  // The opposite failure from the leak: a hold that never settles would drop the tail of
  // every turn that ends mid-block.
  const { reasoning } = await think([`Thinking about it. <${B}${B}DSML${B}${B}invoke name="pwsh"><${B}${B}DSML${B}${B}parameter nam`]);
  assert.match(reasoning, /Thinking about it/u, 'the readable part was dropped');
  assert.equal(MARKUP.test(reasoning), false, `markup leaked: ${JSON.stringify(reasoning)}`);
});

test('the open-block test knows the difference', () => {
  // The predicate the hold is built on. It was first written counting ASCII bars against a
  // normalizer that emits fullwidth ones, so it answered `false` for every input and the
  // leak it was meant to stop carried on; these cases would have caught that immediately.
  assert.equal(hasUnclosedCallMarkup(`<${B}${B}DSML${B}${B}invoke name="pwsh">`), true, 'a lone opener is open');
  assert.equal(hasUnclosedCallMarkup(`<${B}${B}DSML${B}${B}invoke n`), true, 'an unterminated tag is open');
  assert.equal(hasUnclosedCallMarkup('<invoke name="pwsh">'), true, 'the bare spelling too');
  assert.equal(hasUnclosedCallMarkup(NATIVE), false, 'a complete native block is closed');
  assert.equal(hasUnclosedCallMarkup(BARE), false, 'a complete bare block is closed');
  assert.equal(hasUnclosedCallMarkup(''), false, 'empty text has nothing open');
  assert.equal(hasUnclosedCallMarkup('just prose'), false, 'prose has nothing open');
});
