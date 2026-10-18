/**
 * Does the guard cut anything a user would want?
 *
 * The leak guards exist to stop markup reaching the screen. The risk they carry is
 * the opposite failure: eating legitimate output. The dangerous case is a user who
 * asks the model to *print* a marker verbatim — a question about the syntax, a
 * code sample, a bug report. If the guard turns that into a tool call, it has
 * invented an action nobody asked for.
 *
 * Three cases, through the real translator:
 *
 *   A. literal bracketed text in the answer      -> must be preserved, no call
 *   B. literal native marker quoted in the answer -> preserved as text, no call
 *   C. a genuine leaked native call (no prose)    -> recovered as a real call
 *
 * Run with `node test/dsml-boundary.mjs`.
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

function sse(pieces) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const piece of pieces) {
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

async function collect(pieces) {
  const conversation = new WorkBuddyConversation({
    client: { region: 'global', chatStream: async () => sse(pieces) },
    resolveCredential: async () => ({ token: 'x' })
  });
  const chunks = [];
  for await (const chunk of conversation.send([{ role: 'user', text: 'go' }], { model: 'm' })) chunks.push(chunk);
  return {
    text: chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''),
    calls: chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block),
    finish: chunks.find((chunk) => chunk.type === 'finish')
  };
}

console.log('# quoted text must survive\n');

const quotedBracket = await collect([
  'The rendered form looks like this: ',
  '[tool call: pwsh {"command":"Get-ChildItem"}]',
  ' — that is text, not an invocation.'
]);
check('bracketed text the model is quoting is preserved', () => {
  equal(quotedBracket.text.includes('[tool call:'), true, 'text kept');
  equal(quotedBracket.text.includes('that is text, not an invocation.'), true, 'tail kept');
});
check('and no tool call is invented from it', () => {
  equal(quotedBracket.calls.length, 0, 'calls');
  equal(quotedBracket.finish.reason, { kind: 'stop' }, 'reason');
});

const quotedNative = await collect([
  'In the raw stream it appears as <｜｜DSML｜｜invoke name="x"> inside the content field.'
]);
check('a quoted native marker stays readable', () => {
  equal(quotedNative.text.includes('inside the content field.'), true, 'tail kept');
});
check('and still invents nothing', () => {
  equal(quotedNative.calls.length, 0, 'calls');
});

console.log('\n# a genuine leak is still recovered\n');

const M = (name) => `<｜｜DSML｜｜${name}>`;
const CLOSE = (name) => `</｜｜DSML｜｜${name}>`;
const genuine = [
  M('calls'),
  `  ${M('invoke name="pwsh"')}`,
  `    ${M('parameter name="command" string="true"')}Get-ChildItem${CLOSE('parameter')}`,
  `  ${CLOSE('invoke')}`,
  CLOSE('calls')
].join('\n');

const recovered = await collect([genuine]);
check('the call is recovered with its arguments', () => {
  equal(recovered.calls.length, 1, 'count');
  equal(recovered.calls[0].name, 'pwsh', 'name');
  equal(JSON.parse(recovered.calls[0].arguments), { command: 'Get-ChildItem' }, 'arguments');
});
check('and the turn is a tool-calls turn', () => {
  equal(recovered.finish.reason, { kind: 'tool-calls' }, 'reason');
});

console.log('\n# ordinary text is untouched\n');

const ordinary = [
  'Here is a comparison: a < b and c > d.',
  ' Bracketed prose [like this] stays.',
  ' Even <div> markup stays.'
];
const plain = await collect(ordinary);
check('angle brackets and square brackets survive', () => {
  equal(plain.text, ordinary.join(''), 'text');
});
check('nothing is invented', () => {
  equal(plain.calls.length, 0, 'calls');
});

console.log('');
if (failures > 0) {
  console.log(`# dsml-boundary: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# dsml-boundary: OK');
