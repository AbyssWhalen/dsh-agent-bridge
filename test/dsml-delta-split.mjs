/**
 * The same call blocks as `dsml-dialects.mjs`, but arriving **as a stream**.
 *
 * This exists because the two failures are genuinely different. A block that parses
 * perfectly in one piece can still lose its opening to the transcript: the driver releases
 * a tail only while `endsWithMarkerPrefix()` says it could still become a marker, and a
 * delta boundary in the wrong place decides that for it. The live captures contain the
 * proof — `<｜toolDSML｜｜calls>` reached the screen because the model sent `<` then
 * `｜toolDSML` then `｜｜calls>`, and the second of those three does not look like the start
 * of anything.
 *
 * So every case here runs through the real driver, twice: once with the captured delta
 * boundaries, and once cut into single characters, which is the worst case for any hold
 * rule that reasons about prefixes.
 *
 * The assertions are about the *output*, not the parser: no fullwidth bar may reach the
 * text channel, and the call must arrive as a `tool-call` block with its arguments.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';

const runtimePath = fileURLToPath(new URL('./fake-delta-runtime.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'dsh-delta-'));

let passed = 0;
let failed = 0;

/**
 * @param {string} name
 * @param {() => Promise<void>} body
 */
async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split('\n')[0]}`);
  }
}

/**
 * Run one turn against a scripted stream.
 *
 * @param {string[]} deltas
 * @param {boolean} split - cut the joined script into single characters.
 * @returns {Promise<{text: string, calls: {name: string, arguments: string}[], chunks: object[]}>}
 */
async function run(deltas, split) {
  const scriptPath = join(scratch, `deltas-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scriptPath, JSON.stringify(split ? [deltas.join('')] : deltas));
  process.env.FAKE_DELTAS_FILE = scriptPath;
  if (split) process.env.FAKE_SPLIT = '1';
  else delete process.env.FAKE_SPLIT;

  const conversation = new QoderConversation({
    runtimePath,
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });

  const chunks = [];
  try {
    for await (const chunk of conversation.send(
      [
        { role: 'system', text: 'You are a coding agent.' },
        { role: 'user', text: 'list the files' }
      ],
      { model: 'fake-model-1', effort: 'low' }
    )) {
      chunks.push(chunk);
    }
  } finally {
    await conversation.close();
  }

  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('');
  const calls = chunks
    .filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
    .map((chunk) => ({ name: chunk.block.name, arguments: chunk.block.arguments }));
  return { text, calls, chunks };
}

/** The captured boundary of a live run: 17 characters that broke the old hold rule. */
const LIVE_BOUNDARIES = [
  '<',
  '｜toolDSML',
  '｜｜calls>',
  '\n<｜｜',
  'DSML｜｜',
  'invoke name="pw',
  'sh">\n<',
  '｜DSML｜',
  '｜parameter name="',
  'command string="true',
  '">Get-Location</',
  '｜｜DSML',
  '｜｜parameter>',
  '\n</｜',
  'DSML｜｜',
  'invoke>\n</',
  '｜｜DSML',
  '｜｜calls>'
];

for (const split of [false, true]) {
  const label = split ? 'one character at a time' : 'the captured delta boundaries';

  await check(`native control tokens yield a call (${label})`, async () => {
    // The tokenizer's own reserved tokens, streamed, in both shapes the model writes them.
    //
    // **Wrapped** is the live capture. It would pass even without the native spellings in
    // the marker: `<｜｜DSML｜｜calls>` arrives first and the hold follows the wrapper, so the
    // native tokens inside never have to be recognisable on their own.
    //
    // **Unwrapped** is the case that actually depends on it, and the reason the native
    // tokens were added to `MARKER`. Nothing before `<｜｜｜｜｜▁begin｜` looks like a marker,
    // so with one character per delta the opening is released as text and the block is gone
    // by the time `tool▁sep` makes the shape obvious. Measured without the marker change:
    // `calls=0`, bars in the text channel.
    const wrapped = [
      '<｜｜DSML｜｜calls>',
      '<｜｜｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh',
      '```json',
      '{"command": "Get-ChildItem -Force | Select-Object Name"}',
      '```<｜｜DSML｜｜call▁end｜>',
      '</｜｜DSML｜calls>'
    ].join('\n');
    const unwrapped = [
      'Let me look at the files.',
      '<｜｜｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh',
      '```json',
      '{"command": "Get-ChildItem -Force | Select-Object Name"}',
      '```<｜｜DSML｜｜call▁end｜>'
    ].join('\n');

    for (const block of [wrapped, unwrapped]) {
      const { text, calls } = await run([block], split);
      assert.equal(calls.length, 1, `expected 1 call, got ${calls.length} from ${JSON.stringify(block.slice(0, 40))}`);
      assert.equal(calls[0].name, 'pwsh');
      assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-ChildItem -Force | Select-Object Name' });
      assert.equal(/[\uFF5C\u2581]/u.test(text), false, `markup reached the text channel: ${JSON.stringify(text)}`);
    }
  });

  await check(`an interposed wrapper yields a call (${label})`, async () => {
    const { text, calls } = await run(LIVE_BOUNDARIES, split);
    assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
    assert.equal(calls[0].name, 'pwsh');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location' });
    assert.equal(/[\uFF5C]/u.test(text), false, `bars reached the text channel: ${JSON.stringify(text)}`);
  });

  await check(`a tool_name sibling block yields a call (${label})`, async () => {
    const { text, calls } = await run(
      ['I will list the files.\n\n<｜tool_name>pwsh</｜tool_name>\n<command>Get-ChildItem</command>\n<description>list</description>\n</tool_response>'],
      split
    );
    assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
    assert.equal(calls[0].name, 'pwsh');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-ChildItem', description: 'list' });
    assert.equal(/[\uFF5C]/u.test(text), false, `bars reached the text channel: ${JSON.stringify(text)}`);
    assert.ok(text.includes('I will list the files.'), `the prose before the block was lost: ${JSON.stringify(text)}`);
  });
}

await check('an unclosed invoke still yields the call it specified', async () => {
  const { calls } = await run(
    [
      '<｜｜DSML｜｜calls>\n<｜｜｜｜｜｜｜invoke name="pwsh">\n',
      '<｜｜｜｜parameter name="command">Get-Location</｜｜｜｜｜parameter>\n',
      '<｜｜｜｜parameter name="description">print the cwd</｜｜｜｜｜parameter>\n',
      '</｜｜｜parameter>\n</｜｜｜parameter>'
    ],
    false
  );
  assert.equal(calls.length, 1, `expected 1 call, got ${calls.length}`);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location', description: 'print the cwd' });
});

await check('a degenerate bar run fails the turn instead of rendering', async () => {
  const runaway = `<${'｜'.repeat(500)}......`;
  let failure;
  let text = '';
  try {
    const result = await run([runaway], false);
    text = result.text;
  } catch (error) {
    failure = error;
  }
  assert.ok(failure !== undefined, `the turn completed; text was ${JSON.stringify(text.slice(0, 80))}`);
  assert.match(failure.message, /repetition loop/u, `the reason does not name the cause: ${failure.message}`);
  assert.equal(/[\uFF5C]/u.test(text), false, `bars reached the text channel: ${JSON.stringify(text.slice(0, 80))}`);
});

await check('an unreadable call shows the block as written, not a stripped husk', async () => {
  // A tool name that is not an identifier cannot be dispatched, so nothing runs. The
  // interesting question is what the user is shown: stripping the tags would leave
  // `some tool` behind as prose, which reads as the model babbling and hides the failure.
  const block = 'Let me try this.\n<｜tool_name>some tool</｜tool_name>\n<command>echo hi</command>';
  const { text, calls } = await run([block], false);
  assert.equal(calls.length, 0, 'a name that is not an identifier must not run a tool');
  assert.ok(text.includes('tool_name'), `the block was stripped down to ${JSON.stringify(text)}`);
  assert.ok(text.includes('Let me try this.'), `the prose before the block was lost: ${JSON.stringify(text)}`);
});

await check('a call followed by a repetition loop still runs the call', async () => {
  // The two failure shapes overlap: a model can specify its call correctly and *then*
  // degenerate. Failing the whole turn would throw away a call that was complete, so the
  // recovered call has to win over the degenerate verdict.
  const block = [
    '<｜｜DSML｜｜calls>',
    '<｜｜DSML｜invoke name="pwsh">',
    '<｜｜DSML｜｜parameter name="command">Get-Location</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜invoke>',
    '</｜｜DSML｜calls>',
    '｜'.repeat(500)
  ].join('\n');
  const { text, calls } = await run([block], false);
  assert.equal(calls.length, 1, `the complete call was discarded; text was ${JSON.stringify(text.slice(0, 80))}`);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'Get-Location' });
  assert.equal(/[\uFF5C]{24,}/u.test(text), false, 'the bar run reached the text channel');
});

await check('prose that merely mentions bars is not touched', async () => {
  const prose = 'A markdown table looks like this:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const { text, calls } = await run([prose], true);
  assert.equal(calls.length, 0);
  assert.equal(text, prose);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\ndsml delta split: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
