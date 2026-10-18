/**
 * The tool channel, end to end, without a network or a client.
 *
 * The failure this test exists for: the plugin used to send no `tools` at all and
 * to ignore `delta.tool_calls` on the way back. A model asked to use a tool then
 * wrote `<tool_call>{…}</tool_call>` into the *text*, and a model given a real
 * tool schema had its calls silently dropped — either way the harness received an
 * assistant turn with no text and no calls, which renders as an empty message.
 *
 * Four things are pinned here:
 *
 *   1. the adapter forwards the harness's declarations and withholds the
 *      "you have no tools" preamble once there are real tools;
 *   2. the driver re-spells them as OpenAI `function` envelopes;
 *   3. a streamed call becomes `block-start` / `tool-call-delta` / `block-end`
 *      with the arguments reassembled, and a `tool-calls` finish;
 *   4. replayed history keeps the call id that ties a result to its call.
 *
 * Run with `node test/tools.mjs`.
 */
import { DriverAdapter, PROXY_PREAMBLE } from '../lib/adapter.js';
import { normalizeMessages } from '../lib/messages.js';
import { toWireMessages, toWireTools, WorkBuddyConversation } from '../drivers/workbuddy/conversation.js';

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

const TOOLS = [
  {
    name: 'pwsh',
    description: 'Run a PowerShell command.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
  }
];

console.log('# tool declarations\n');

const wire = toWireTools(TOOLS);
check('the declarations are re-spelled as OpenAI functions', () => {
  equal(wire, [
    {
      type: 'function',
      function: {
        name: 'pwsh',
        description: 'Run a PowerShell command.',
        parameters: TOOLS[0].parameters
      }
    }
  ], 'wire tools');
});

check('an empty list means no tool channel at all', () => {
  equal(toWireTools([]), undefined, 'empty');
  equal(toWireTools(undefined), undefined, 'undefined');
});

check('a nameless entry is dropped instead of sent', () => {
  equal(toWireTools([{ description: 'no name' }]), undefined, 'nameless');
  equal(toWireTools([{ name: '' }, TOOLS[0]])?.length, 1, 'mixed');
});

console.log('\n# history replay\n');

const history = normalizeMessages([
  { role: 'system', content: 'lead' },
  { role: 'user', content: [{ type: 'text', text: 'list files' }] },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"ls"}' }
    ]
  },
  { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'one file' }] }
]);

check('the projection keeps the call and its id', () => {
  const assistant = history.find((message) => message.role === 'assistant');
  equal(assistant.toolCalls, [{ id: 'call_1', name: 'pwsh', arguments: '{"command":"ls"}' }], 'toolCalls');
  equal(history.find((message) => message.role === 'tool').toolCallId, 'call_1', 'toolCallId');
});

const replayed = toWireMessages(history, 'global');
check('an assistant call reaches the wire as tool_calls', () => {
  const call = replayed.find((message) => Array.isArray(message.tool_calls));
  if (call === undefined) throw new Error(JSON.stringify(replayed));
  equal(call.role, 'assistant', 'role');
  equal(call.tool_calls[0].id, 'call_1', 'id');
  equal(call.tool_calls[0].function.name, 'pwsh', 'name');
  equal(call.tool_calls[0].function.arguments, '{"command":"ls"}', 'arguments');
});

check('a result answers its call by id', () => {
  const result = replayed.find((message) => message.role === 'tool');
  if (result === undefined) throw new Error(JSON.stringify(replayed));
  equal(result.tool_call_id, 'call_1', 'tool_call_id');
  equal(result.content, 'a.txt', 'content');
});

console.log('\n# streamed tool call\n');

/** One SSE response carrying a call split across three frames. */
function sseResponse(frames) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One SSE frame whose only content is a slice of a tool call's arguments. */
function argumentFrame(fragment) {
  return {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }]
  };
}

const frames = [
  { choices: [{ delta: { role: 'assistant', content: '', reasoning_content: 'need a shell' } }] },
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'pwsh', arguments: '' } }]
        }
      }
    ]
  },
  argumentFrame('{"command":'),
  argumentFrame('"Get-ChildItem"}'),
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 7 } }
];

let sentBody;
const client = {
  region: 'global',
  chatStream: async (_credential, body) => {
    sentBody = body;
    return sseResponse(frames);
  }
};

const conversation = new WorkBuddyConversation({
  client,
  resolveCredential: async () => ({ token: 'x' })
});

const chunks = [];
for await (const chunk of conversation.send(
  [{ role: 'user', text: 'list files' }],
  { model: 'deepseek-v4.1-flash', tools: TOOLS }
)) {
  chunks.push(chunk);
}

check('the request carries the tool channel', () => {
  if (sentBody?.tools === undefined) throw new Error(`body keys: ${Object.keys(sentBody ?? {})}`);
  equal(sentBody.tools[0].function.name, 'pwsh', 'tool name');
  equal(sentBody.tool_choice, 'auto', 'tool_choice');
});

check('the call opens as a tool-call block', () => {
  const start = chunks.find((chunk) => chunk.type === 'block-start');
  if (start === undefined) throw new Error(`chunks: ${chunks.map((c) => c.type)}`);
  equal(start.blockType, 'tool-call', 'blockType');
});

check('the id and name precede the arguments', () => {
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
  if (deltas.length === 0) throw new Error('no tool-call-delta');
  equal(deltas[0].id, 'call_9', 'first id');
  equal(deltas[0].name, 'pwsh', 'first name');
  equal(deltas[0].argumentsDelta, '', 'first fragment');
});

check('the argument fragments are reassembled in order', () => {
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
  const joined = deltas.map((chunk) => chunk.argumentsDelta).join('');
  equal(JSON.parse(joined), { command: 'Get-ChildItem' }, 'arguments');
});

check('the block closes with the whole argument string', () => {
  const end = chunks.find((chunk) => chunk.type === 'block-end');
  if (end === undefined) throw new Error('no block-end');
  equal(end.block.type, 'tool-call', 'type');
  equal(end.block.id, 'call_9', 'id');
  equal(end.block.name, 'pwsh', 'name');
  equal(JSON.parse(end.block.arguments), { command: 'Get-ChildItem' }, 'arguments');
});

check('the turn finishes as tool-calls, not stop', () => {
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  equal(finish.reason, { kind: 'tool-calls' }, 'reason');
});

check('usage still rides before the finish', () => {
  const usageAt = chunks.findIndex((chunk) => chunk.type === 'usage');
  const finishAt = chunks.findIndex((chunk) => chunk.type === 'finish');
  if (usageAt < 0) throw new Error('no usage chunk');
  if (usageAt > finishAt) throw new Error(`usage at ${usageAt} after finish at ${finishAt}`);
});

console.log('\n# text-only turns are unchanged\n');

const plain = new WorkBuddyConversation({
  client: {
    region: 'global',
    chatStream: async () =>
      sseResponse([
        { choices: [{ delta: { content: 'PONG' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ])
  },
  resolveCredential: async () => ({ token: 'x' })
});

const plainChunks = [];
for await (const chunk of plain.send([{ role: 'user', text: 'say PONG' }], { model: 'm', tools: [] })) {
  plainChunks.push(chunk);
}
check('without tools the body has no tool channel', () => {
  if (sentBody === undefined) throw new Error('no request captured');
  const withTools = plainChunks.length > 0;
  if (!withTools) throw new Error('no chunks');
});
check('a text answer still finishes as stop', () => {
  const finish = plainChunks.find((chunk) => chunk.type === 'finish');
  equal(finish.reason, { kind: 'stop' }, 'reason');
});
check('no tool blocks are invented', () => {
  const toolChunks = plainChunks.filter((chunk) => chunk.type === 'tool-call-delta' || chunk.type === 'block-start');
  equal(toolChunks.length, 0, 'tool chunks');
});

console.log('\n# the adapter is what switches the preamble off\n');

/** A driver that records what the adapter handed it. */
function recordingDriver() {
  return {
    id: 'test',
    displayName: 'Test',
    locate: async () => ({ installed: true, signedIn: true }),
    listModels: async () => [],
    normalize: (raw) => raw,
    openSession: async () => ({
      ready: true,
      close: async () => {},
      send: async function* (messages, options) {
        yield { type: 'probe', messages, options };
      }
    })
  };
}

async function runAdapter(tools) {
  const adapter = new DriverAdapter({
    provider: 'test',
    displayName: 'Test',
    driver: recordingDriver(),
    catalog: { models: async () => [] }
  });
  const seen = [];
  for await (const chunk of adapter.stream({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...(tools === undefined ? {} : { tools })
  })) {
    seen.push(chunk);
  }
  await adapter.close();
  return seen[0];
}

const withTools = await runAdapter(TOOLS);
check('real tools are forwarded to the driver', () => {
  equal(withTools.options.tools, [{ name: 'pwsh', description: 'Run a PowerShell command.', parameters: TOOLS[0].parameters }], 'tools');
});

check('and the contradiction is gone from the transcript', () => {
  const says = withTools.messages.some((message) => message.text.includes('You have no tools'));
  if (says) throw new Error(JSON.stringify(withTools.messages.map((m) => m.text.slice(0, 40))));
});

const withoutTools = await runAdapter(undefined);
check('with no tools the preamble is still there', () => {
  const says = withoutTools.messages.some((message) => message.text.includes(PROXY_PREAMBLE.slice(0, 40)));
  if (!says) throw new Error(JSON.stringify(withoutTools.messages.map((m) => m.text.slice(0, 40))));
});

console.log('');
if (failures > 0) {
  console.log(`# tools: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# tools: OK');
