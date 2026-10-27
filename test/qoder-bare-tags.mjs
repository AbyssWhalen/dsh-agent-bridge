/**
 * End-to-end: the bare-tag recovery, driven through the real `QoderConversation`.
 *
 * This file exists because the unit tests were green while the stream still leaked. Every
 * assertion in `dsml-bare-tags.mjs` feeds one complete string to the parser, and the parser
 * was never wrong — what was wrong was the *hold*, the rule that decides whether a tail can
 * still become a marker. With one-character deltas the tail `<invoke n` has its space
 * stripped by the whitespace normalisation, collapses to `invoken`, matches no tag prefix,
 * and is released — so `<invoke name="pwsh">` reached the screen a character at a time and
 * the tool never ran.
 *
 * A batch test cannot see that. Only feeding the block through the same path the vendor
 * stream uses can, which is what this file does: a scripted runtime, the real conversation
 * object, and the chunk stream a user would receive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QoderConversation } from '../drivers/qoder/conversation.js';

const B = '\uFF5C';
const scratch = mkdtempSync(join(tmpdir(), 'dsh-bare-tags-'));

/**
 * Run one turn against the scripted runtime and collect what a user would receive.
 *
 * @param {string[]} deltas
 * @param {boolean} [split] - feed the joined script one character at a time.
 * @returns {Promise<{text: string, calls: {name: string, args: string}[]}>}
 */
async function turn(deltas, split = false) {
  const file = join(scratch, `d-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(deltas));
  process.env.FAKE_DELTAS_FILE = file;
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
  }

  return {
    text: chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''),
    // Calls arrive as `tool-call-delta` frames closed by a `block-end` carrying the
    // assembled call; there is no plain `tool-call` frame.
    calls: chunks
      .filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
      .map((c) => ({ name: c.block.name, args: c.block.arguments }))
  };
}

test.after(() => rmSync(scratch, { recursive: true, force: true }));

/** The stored turn from the live session: prose, then bare tags, then a cut-off value. */
const STORED =
  '我先确认一下磁盘上的状态文件是否已经写好。 <invoke name="pwsh"> <parameter name="command">$t=\'D:\\x\\a';

test('the stored turn runs the tool instead of printing the markup', async () => {
  const { text, calls } = await turn([STORED]);
  assert.equal(calls.length, 1, `expected one call; got ${calls.length}`);
  assert.match(calls[0].name, /pwsh/);
  assert.equal(text.includes('invoke'), false, 'the markup must not reach the user');
  assert.equal(text.includes('parameter'), false);
});

test('the sentence the model actually said still arrives', async () => {
  const { text } = await turn([STORED]);
  assert.match(text, /磁盘上的状态文件/);
});

test('the same block split into single characters still recovers', async () => {
  // The case that was broken: the batch parser handled STORED correctly while this
  // spelling of the same turn leaked the tags one character at a time.
  const { text, calls } = await turn([STORED], true);
  assert.equal(calls.length, 1, 'a split stream must still recover the call');
  assert.equal(text.includes('<inv'), false, 'no half tag may reach the user');
  assert.match(text, /磁盘上的状态文件/, 'and the prose is still there');
});

test('a fully closed bare call is executed', async () => {
  const { text, calls } = await turn(['<invoke name="pwsh"><parameter name="command">Get-Date</parameter></invoke>']);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].args), { command: 'Get-Date' });
  assert.equal(text.includes('<invoke'), false);
});

test('the mixed native+bare form yields exactly one call', async () => {
  const { text, calls } = await turn([
    `好的。<${B}｜DSML｜${B} calls> <invoke name="pwsh"> <parameter name="command">echo hi</parameter>`
  ]);
  assert.equal(calls.length, 1, 'one intent must not become two calls');
  assert.equal(text, '好的。');
});

test('ordinary prose passes through untouched', async () => {
  const prose = 'The build finished successfully in 42 seconds.';
  const { text, calls } = await turn([prose]);
  assert.equal(text, prose);
  assert.equal(calls.length, 0);
});

test('html-looking prose is not swallowed as a call', async () => {
  // `<code>` shares a prefix with `calls`, so the hold delays it briefly; what must not
  // happen is the text disappearing or a call being invented.
  const prose = 'Wrap the command in <code>backticks</code> and run it.';
  const { text, calls } = await turn([prose]);
  assert.equal(calls.length, 0);
  assert.match(text, /backticks/, `the text must survive; got ${JSON.stringify(text)}`);
});

test('an unrecoverable attempt never reaches the user as markup', async () => {
  // An opener with no parameters: the turn was cut off before it asked for anything, so
  // there is no call to invent. What must not happen is the block being printed — that is
  // the shape the user reported as "a big chunk of noise", and this is the branch that
  // produced it. The prose in front of it is still the model's answer and is kept.
  const { text, calls } = await turn(['Let me look at that. <invoke name="pwsh">']);
  assert.equal(calls.length, 0, 'nothing was actually asked for');
  assert.equal(/invoke|parameter|</u.test(text), false, `markup reached the user: ${JSON.stringify(text)}`);
  assert.match(text, /Let me look at that/, 'and the sentence before it survives');
});

test('a reply opening with a stray tag shows no markup', async () => {
  // Same shape without leading prose: nothing usable remains, so the turn reads as empty.
  // That is a state the host already retries; printing the tag is not.
  const { text, calls } = await turn(['<parameter name="command">Get-Date']);
  assert.equal(calls.length, 0);
  assert.equal(/parameter|</u.test(text), false, `markup reached the user: ${JSON.stringify(text)}`);
});

test('prose that merely mentions a tag keeps its words', async () => {
  // Mid-sentence markup is explanation, not a call attempt. Stripping it would garble the
  // one case where the text itself is the answer.
  const { text, calls } = await turn(['The parser accepts <parameter name="x"> as an argument.']);
  assert.equal(calls.length, 0);
  assert.match(text, /accepts/, `the sentence must survive; got ${JSON.stringify(text)}`);
});
