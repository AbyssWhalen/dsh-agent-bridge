/**
 * WorkBuddy's reasoning channel.
 *
 * The same defect the Qoder driver had, in a second implementation. `acceptReasoning` held
 * a block while `hasLeak` was true, but decided the block had *finished* by looking for
 * `</｜｜DSML…` anywhere near the end of the buffer. Streamed one character at a time that
 * fragment arrives long before the block ends: the driver stripped what it had, cleared the
 * buffer, and the remainder of the block — now carrying no recognisable opening — was
 * released as ordinary reasoning. Measured: `｜｜parameter></｜｜DSML｜｜invoke>` reached the
 * caller.
 *
 * The fix asks the block, not the buffer, whether it has closed, using the same
 * `hasUnclosedCallMarkup` the Qoder driver holds on. One predicate, three call sites, so a
 * spelling the parser learns is understood everywhere without a second copy of the rules.
 *
 * These tests inject `chatStream`, so no network and no credentials are involved. The split
 * is what matters: every one of these shapes is green when the block arrives whole.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { WorkBuddyConversation } = await import('../drivers/workbuddy/conversation.js');

const B = '\uFF5C';
const encoder = new TextEncoder();
/** Anything that came from the wire format rather than from the model's own words. */
const MARKUP = /[｜|]{2}|DSML|invoke|parameter|\[tool call/iu;

/** A Response-shaped object yielding the given SSE lines. */
const bodyOf = (lines) => ({
  body: {
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield encoder.encode(line);
    }
  }
});

/** SSE lines carrying each string as a reasoning delta, then the terminator. */
const linesFor = (parts) => [
  ...parts.map((part) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: part } }] })}\n\n`),
  'data: [DONE]\n\n'
];

/**
 * Run one turn and report each channel.
 *
 * @param {string[]} parts - reasoning delta strings, in order.
 */
async function think(parts) {
  const conversation = new WorkBuddyConversation({
    client: { region: 'cn', chatStream: async () => bodyOf(linesFor(parts)) },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug() {}, warn() {} }
  });
  let reasoning = '';
  let text = '';
  let error;
  try {
    for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'fake-model' })) {
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text ?? '';
      if (chunk.type === 'text-delta') text += chunk.text ?? '';
      if (chunk.type === 'error') error = chunk.error;
    }
  } catch (caught) {
    error = caught;
  }
  return { reasoning, text, error };
}

const NATIVE = `<${B}${B}DSML${B}${B}invoke name="pwsh"><${B}${B}DSML${B}${B}parameter name="command">Get-Date</${B}${B}DSML${B}${B}parameter></${B}${B}DSML${B}${B}invoke>`;
const BARE = '<invoke name="pwsh"><parameter name="command">Get-Date</parameter></invoke>';

test('a call block never reaches the reasoning channel, however it is split', async () => {
  const shapes = {
    'native, one delta': [NATIVE],
    'native, one character at a time': [...NATIVE],
    'native, split inside the opening': [NATIVE.slice(0, 7), NATIVE.slice(7)],
    'bare, one delta': [BARE],
    'bare, one character at a time': [...BARE],
    'bare, split after the opener': [BARE.slice(0, 21), BARE.slice(21)],
    'a native opener that never closes': [`<${B}${B}DSML${B}${B}invoke name="pwsh">`],
    'a bare opener that never closes': ['<invoke name="pwsh">'],
    'the bracket form, open': ['[tool call: pwsh {"command":"Get-D']
  };

  const failures = [];
  for (const [label, parts] of Object.entries(shapes)) {
    const { reasoning } = await think(parts);
    if (MARKUP.test(reasoning)) failures.push(`${label} -> ${JSON.stringify(reasoning.slice(0, 80))}`);
  }
  assert.deepEqual(failures, [], `markup reached the reasoning channel:\n${failures.join('\n')}`);
});

test('prose around a block still arrives, streamed or not', async () => {
  for (const parts of [[`Let me think. ${NATIVE}`], [...`Let me think. ${NATIVE}`]]) {
    const { reasoning } = await think(parts);
    assert.match(reasoning, /Let me think/u, `prose lost: ${JSON.stringify(reasoning)}`);
    assert.equal(MARKUP.test(reasoning), false, `markup leaked: ${JSON.stringify(reasoning)}`);
  }
});

test('ordinary reasoning is untouched', async () => {
  const plain = 'Nothing to call here, just thinking about the wording.';
  const { reasoning } = await think([plain]);
  assert.equal(reasoning, plain, 'plain reasoning must reach the caller exactly as written');
});

test('a plain thought split into characters is still whole', async () => {
  // The hold must not eat the tail of an ordinary thought: only a marker may trigger it.
  const plain = 'Weighing two options before answering.';
  const { reasoning } = await think([...plain]);
  assert.equal(reasoning, plain, `reasoning altered by the guard: ${JSON.stringify(reasoning)}`);
});

test('an unclosed marker is cut, and the prose before it is kept', async () => {
  // `stripLeak` leaves an unterminated form alone on purpose — for history it is more
  // likely prose about the syntax than a truncated call. At the end of a turn that policy
  // is wrong, so the settle path truncates first.
  const { truncateOpenMarkup } = await import('../lib/dsml.js');
  const cut = {
    '[tool call: … with no bracket': ['[tool call: pwsh {"command":"Get-D', ''],
    'the same, after prose': ['Let me think. [tool call: pwsh {"command":"Get-D', 'Let me think. '],
    'a native block with no close': [`<${B}${B}DSML${B}${B}invoke name="pwsh">`, ''],
    'the same, after prose': [`Thinking. <${B}${B}DSML${B}${B}invoke name="pwsh">`, 'Thinking. '],
    'a bare block with no close': ['<invoke name="pwsh"><parameter name="command">Get-D', ''],
    'an opening tag with no `>`': ['<invoke name="pwsh"', ''],
    'the same, after prose': ['Thinking. <invoke name="pwsh"', 'Thinking. ']
  };
  for (const [label, [input, expected]] of Object.entries(cut)) {
    assert.equal(truncateOpenMarkup(input), expected, label);
  }
  // Prose that happens to use angle brackets is not a marker and must survive untouched.
  for (const prose of ['Just an answer.', 'The rule is a < b and c > d.', '']) {
    assert.equal(truncateOpenMarkup(prose), prose, `altered prose: ${JSON.stringify(prose)}`);
  }
});
