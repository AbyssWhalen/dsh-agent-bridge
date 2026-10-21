/**
 * The recovery path, exercised through the real translator.
 *
 * `test/dsml.mjs` proves the parser. This proves the wiring: a stream whose
 * *content* deltas carry the model's native call syntax must produce tool-call
 * chunks and no markup in the text, and a stream that carries ordinary prose must
 * still stream through unchanged.
 *
 * Run with `node test/dsml-stream.mjs`.
 */
import { WorkBuddyConversation } from '../drivers/workbuddy/conversation.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function equal(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: ${a} !== ${b}`);
}

const M = (name) => `<｜｜DSML｜｜${name}>`;
const CLOSE = (name) => `</｜｜DSML｜｜${name}>`;

const LEAKED = [
  M('calls'),
  `  ${M('invoke name="pwsh"')}`,
  `    ${M('parameter name="command" string="true"')}Get-ChildItem${CLOSE('parameter')}`,
  `  ${CLOSE('invoke')}`,
  CLOSE('calls')
].join('\n');

/** Split a string into SSE frames, one character group per frame. */
function sseResponse(textPieces) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const piece of textPieces) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function conversationFor(textPieces, warnings = []) {
  return new WorkBuddyConversation({
    client: { region: 'global', chatStream: async () => sseResponse(textPieces) },
    resolveCredential: async () => ({ token: 'x' }),
    logger: { warn: (message) => warnings.push(String(message)) }
  });
}

async function collect(session) {
  const chunks = [];
  for await (const chunk of session.send([{ role: 'user', text: 'list files' }], { model: 'm' })) chunks.push(chunk);
  return chunks;
}

console.log('# a call written as text\n');

const warnings = [];
// Deliberately split mid-marker, so the tail-holding path is exercised too.
const pieces = ['Let me look.\n', LEAKED.slice(0, 8), LEAKED.slice(8), '\nDone.'];
const chunks = await collect(conversationFor(pieces, warnings));

const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
check('no markup reaches the client as text', () => {
  if (/DSML/u.test(text)) throw new Error(`text still has markup: ${JSON.stringify(text)}`);
  if (text.includes('invoke')) throw new Error(`text still has markup: ${JSON.stringify(text)}`);
});

check('the prose around it survives', () => {
  equal(text.includes('Let me look.'), true, 'leading prose');
  equal(text.includes('Done.'), true, 'trailing prose');
});

check('the call comes back as a real tool call', () => {
  const blocks = chunks.filter((chunk) => chunk.type === 'block-end');
  if (blocks.length !== 1) throw new Error(`blocks: ${JSON.stringify(blocks)}`);
  equal(blocks[0].block.type, 'tool-call', 'type');
  equal(blocks[0].block.name, 'pwsh', 'name');
  equal(JSON.parse(blocks[0].block.arguments), { command: 'Get-ChildItem' }, 'arguments');
});

check('the block is announced and streamed in order', () => {
  const types = chunks.map((chunk) => chunk.type);
  const start = types.indexOf('block-start');
  const delta = types.indexOf('tool-call-delta');
  const end = types.indexOf('block-end');
  if (!(start >= 0 && delta > start && end > delta)) throw new Error(`order: ${types.join(',')}`);
});

check('the turn finishes as tool-calls', () => {
  equal(chunks.find((chunk) => chunk.type === 'finish').reason, { kind: 'tool-calls' }, 'reason');
});

check('the recovery is reported rather than silent', () => {
  const said = warnings.find((message) => /recovered 1 tool call/u.test(message));
  if (said === undefined) throw new Error(`warnings: ${JSON.stringify(warnings)}`);
});

console.log('\n# the same call with a single-bar opening\n');

// Qwen-3.8-MAX writes the opening delimiter with one bar and closes with two.
const M1 = (name) => `<｜｜DSML｜${name}>`;
const oneBarWarnings = [];
const oneBar = [
  M1('calls'),
  `  ${M1('invoke name="pwsh"')}`,
  `    ${M1('parameter name="command" string="true"')}Get-ChildItem${CLOSE('parameter')}`,
  `  ${CLOSE('invoke')}`,
  CLOSE('calls')
].join('\n');
const oneBarPieces = ['Working.\n', oneBar.slice(0, 10), oneBar.slice(10), '\nDone.'];
const oneBarChunks = await collect(conversationFor(oneBarPieces, oneBarWarnings));
const oneBarText = oneBarChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');

check('the one-bar envelope never reaches the client as text', () => {
  if (/DSML/u.test(oneBarText)) throw new Error(`text still has markup: ${JSON.stringify(oneBarText)}`);
  if (/invoke|parameter/u.test(oneBarText)) throw new Error(`text still has markup: ${JSON.stringify(oneBarText)}`);
});

check('the one-bar call is executed', () => {
  const blocks = oneBarChunks.filter((chunk) => chunk.type === 'block-end');
  if (blocks.length !== 1) throw new Error(`blocks: ${JSON.stringify(blocks)}`);
  equal(blocks[0].block.name, 'pwsh', 'name');
  equal(JSON.parse(blocks[0].block.arguments), { command: 'Get-ChildItem' }, 'arguments');
});

console.log('\n# the letterless delimiter, as a live turn wrote it\n');

/*
 * Captured from a real DSH agent loop on `qoder/qmodel_38max`: the opening delimiter
 * arrived as five fullwidth bars with **no** `DSML`, while the `parameter` tags inside
 * it and the closing tag used the canonical spelling. The whole envelope was therefore
 * unrecognised — the markup rendered as a wall of bars and, because it was never
 * parsed as a call, `pwsh` never ran.
 *
 * The split points below are chosen to land inside the bare run of bars, which is the
 * case the tail-holding path has to survive: the driver cannot know yet whether the
 * bars are a marker or prose, so it must hold them until the tag name arrives.
 */
const B5 = (name) => `<｜｜｜｜｜${name}>`;
const letterless = [
  M('calls'),
  `  ${B5('invoke name="pwsh"')}`,
  `    ${M('parameter name="command" string="true"')}Get-ChildItem -File${CLOSE('parameter')}`,
  `    ${M('parameter name="description" string="true"')}List .txt files${CLOSE('parameter')}`,
  `  ${CLOSE('invoke')}`,
  'List .txt files via PowerShell',
  CLOSE('calls')
].join('\n');

const letterlessWarnings = [];
// Cut three characters into the bare run, so the first frame ends with `<｜｜｜`.
const letterlessPieces = [
  'Working.\n',
  letterless.slice(0, 14),
  letterless.slice(14, 22),
  letterless.slice(22),
  '\nDone.'
];
const letterlessChunks = await collect(conversationFor(letterlessPieces, letterlessWarnings));
const letterlessText = letterlessChunks
  .filter((chunk) => chunk.type === 'text-delta')
  .map((chunk) => chunk.text)
  .join('');

check('no bar-delimited markup reaches the client', () => {
  if (/DSML/u.test(letterlessText)) throw new Error(`text still has markup: ${JSON.stringify(letterlessText)}`);
  if (/｜{2,}/u.test(letterlessText)) throw new Error(`bars still in text: ${JSON.stringify(letterlessText)}`);
  if (/invoke|parameter/u.test(letterlessText)) throw new Error(`tags still in text: ${JSON.stringify(letterlessText)}`);
});

check('the letterless call is executed, not just cleaned up', () => {
  const blocks = letterlessChunks.filter((chunk) => chunk.type === 'block-end');
  if (blocks.length !== 1) throw new Error(`blocks: ${JSON.stringify(blocks)}`);
  equal(blocks[0].block.name, 'pwsh', 'name');
  equal(
    JSON.parse(blocks[0].block.arguments),
    { command: 'Get-ChildItem -File', description: 'List .txt files' },
    'arguments'
  );
});

check('its prose survives on both sides', () => {
  equal(letterlessText.includes('Working.'), true, 'leading prose');
  equal(letterlessText.includes('List .txt files via PowerShell'), true, 'envelope prose');
  equal(letterlessText.includes('Done.'), true, 'trailing prose');
});

console.log('\n# ordinary prose is untouched\n');

const plainWarnings = [];
const plain = await collect(conversationFor(['PONG'], plainWarnings));
const plainText = plain.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
check('the text arrives whole', () => {
  equal(plainText, 'PONG', 'text');
});
check('nothing is invented and nothing is warned about', () => {
  equal(plain.filter((chunk) => chunk.type === 'block-start').length, 0, 'blocks');
  equal(plainWarnings.length, 0, 'warnings');
  equal(plain.find((chunk) => chunk.type === 'finish').reason, { kind: 'stop' }, 'reason');
});

console.log('\n# a late "<" is not swallowed\n');

const ltWarnings = [];
const lt = await collect(conversationFor(['compare a < b'], ltWarnings));
const ltText = lt.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
check('a literal less-than streams through', () => {
  equal(ltText, 'compare a < b', 'text');
});

console.log('');
if (failures > 0) {
  console.log(`# dsml-stream: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# dsml-stream: OK');
