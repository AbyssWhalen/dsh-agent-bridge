/**
 * The two ways leaked call text reached the screen, pinned.
 *
 * Both were observed in a real session, and neither is the upstream's fault:
 *
 *  1. **This plugin seeded it.** `contentText` renders a call as
 *     `[tool call: name {args}]` so a flattened transcript stays readable. That
 *     text was then replayed as the *content* of an assistant message that also
 *     carried structured `tool_calls` — so the model read the bracketed form in
 *     its own voice and copied it. The user sees a burst of pseudo-call text
 *     while the turn streams, and a clean answer at the end.
 *  2. **The reasoning channel was unguarded.** The guard covered content only, so
 *     markup written into `reasoning_content` streamed straight to the thinking
 *     pane.
 *
 * Run with `node test/dsml-history.mjs`.
 */
import { assistantProse, normalizeMessages } from '../lib/messages.js';
import { WorkBuddyConversation, toWireMessages } from '../drivers/workbuddy/conversation.js';
import { hasLeak } from '../lib/dsml.js';

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

console.log('# the seed is not replayed\n');

const history = normalizeMessages([
  { role: 'system', content: 'lead' },
  { role: 'user', content: [{ type: 'text', text: 'list files' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'I should list them.' },
      { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"ls"}' }
    ]
  },
  { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }] }
]);

const wire = toWireMessages(history, 'global');
const assistant = wire.find((message) => Array.isArray(message.tool_calls));

check('the structured call still travels', () => {
  if (assistant === undefined) throw new Error(JSON.stringify(wire));
  equal(assistant.tool_calls[0].function.name, 'pwsh', 'name');
});

check('but the rendered form is not in the content it is sent with', () => {
  const content = assistant.content ?? '';
  if (/\[tool call:/u.test(content)) throw new Error(`content: ${JSON.stringify(content)}`);
});

check('the prose and reasoning still travel', () => {
  const content = assistant.content ?? '';
  equal(content.includes('I should list them.'), true, 'reasoning kept');
});

check('assistantProse drops calls but keeps words', () => {
  const prose = assistantProse({
    content: [
      { type: 'text', text: 'Here is the plan.' },
      { type: 'tool-call', id: 'c', name: 'pwsh', arguments: '{}' },
      { type: 'reasoning', text: 'Because.' }
    ]
  });
  equal(prose, 'Here is the plan.\nBecause.', 'prose');
  if (hasLeak(prose)) throw new Error('markup in prose');
});

console.log('\n# history that already leaked is cleaned\n');

const replayed = toWireMessages(
  normalizeMessages([
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look.\n[tool call: pwsh {"command":"ls"}]' }
      ]
    }
  ]),
  'global'
);

check('a copied pseudo-call is stripped from replayed history', () => {
  const sent = replayed.map((message) => String(message.content ?? '')).join('\n');
  if (/\[tool call:/u.test(sent)) throw new Error(`replayed: ${JSON.stringify(sent)}`);
  equal(sent.includes('Let me look.'), true, 'prose kept');
});

console.log('\n# the reasoning channel is guarded\n');

function sse(pieces) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const piece of pieces) {
        const delta = typeof piece === 'string' ? { reasoning_content: piece } : piece;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
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
  return chunks;
}

const leakBlock = `${M('calls')}  ${M('invoke name="pwsh"')}    ${M('parameter name="command" string="true"')}ls${CLOSE('parameter')}  ${CLOSE('invoke')}${CLOSE('calls')}`;

const reasoningChunks = await collect([
  'I need to run a command. ',
  leakBlock.slice(0, 10),
  leakBlock.slice(10),
  ' Then I will read the output.'
]);
const reasoning = reasoningChunks
  .filter((chunk) => chunk.type === 'reasoning-delta')
  .map((chunk) => chunk.text)
  .join('');

check('no markup survives in the reasoning stream', () => {
  if (/DSML/u.test(reasoning)) throw new Error(`reasoning: ${JSON.stringify(reasoning)}`);
});

check('the reasoning around it is kept', () => {
  equal(reasoning.includes('I need to run a command.'), true, 'lead');
  equal(reasoning.includes('Then I will read the output.'), true, 'tail');
});

check('reasoning alone does not fabricate a tool call', () => {
  equal(reasoningChunks.filter((chunk) => chunk.type === 'block-end').length, 0, 'blocks');
  equal(reasoningChunks.find((chunk) => chunk.type === 'finish').reason, { kind: 'stop' }, 'reason');
});

const renderedChunks = await collect(['Trying the rendered form. ', '[tool call: pwsh {"command":"ls"}]', ' Done.']);
const rendered = renderedChunks
  .filter((chunk) => chunk.type === 'reasoning-delta')
  .map((chunk) => chunk.text)
  .join('');

check('the copied bracketed form is not shown in reasoning', () => {
  if (/\[tool call:/u.test(rendered)) throw new Error(`reasoning: ${JSON.stringify(rendered)}`);
  equal(rendered.includes('Trying the rendered form.'), true, 'lead');
});

console.log('');
if (failures > 0) {
  console.log(`# dsml-history: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# dsml-history: OK');
