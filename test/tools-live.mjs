/**
 * The tool channel against the real upstream, through this plugin's own driver.
 *
 * `test/tools.mjs` proves the translator with synthetic SSE; this proves the same
 * path with a live account. It runs the **whole loop**, not just the call, because
 * the second half is where a tool exchange actually breaks:
 *
 *   turn 1  the request carries `tools`, the model asks for one, the harness-shaped
 *           chunks come back reassembled;
 *   turn 2  the assistant turn is replayed with its `tool_calls`, the result answers
 *           it by `tool_call_id`, and the model produces prose.
 *
 * A single-turn test passes while turn 2 is impossible. Reading only the projected
 * `toolCalls` field, for instance, dropped the assistant turn entirely and left a
 * `tool` message answering nothing — which the upstream refuses with
 * `11148 tool calls and tool results do not match`. That shape was invisible here
 * until the loop was closed, so the loop is what this test is.
 *
 * Run with `node test/tools-live.mjs [modelId]`.
 */
import { driver } from '../drivers/workbuddy/index.js';
import { normalizeMessages } from '../lib/messages.js';
import { verdict } from './verdict.mjs';

const model = process.argv[2] ?? 'deepseek-v4.1-flash';
const outcome = verdict('WorkBuddy tools');

const tools = [
  {
    name: 'pwsh',
    description: 'Run a PowerShell command and return its output.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to execute.' } },
      required: ['command']
    }
  }
];

const session = await driver.openSession({ logger: { debug: () => {}, warn: (m) => console.log(`  warn: ${m}`) } });

/** One turn: send, collect, report. A failure here is a finding, not a flake. */
async function turn(messages, label) {
  // Project exactly as `DriverAdapter.stream` does, so the wire is the real one.
  const chunks = [];
  try {
    for await (const chunk of session.send(normalizeMessages(messages), { model, effort: 'low', tools })) {
      chunks.push(chunk);
    }
  } catch (error) {
    console.log(`\n${label}: FAILED — ${String(error?.message).slice(0, 300)}`);
    return { chunks, failure: error };
  }

  const started = chunks.filter((chunk) => chunk.type === 'block-start');
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
  const ended = chunks.filter((chunk) => chunk.type === 'block-end');
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');

  console.log(`\n${label}`);
  console.log('  chunk types :', [...new Set(chunks.map((chunk) => chunk.type))].join(', ') || '(none)');
  console.log('  block-start :', started.length, JSON.stringify(started.map((chunk) => chunk.blockType)));
  console.log('  deltas      :', deltas.length);
  console.log('  block-end   :', ended.length);
  console.log('  finish      :', JSON.stringify(finish?.reason));
  console.log('  text        :', text.length === 0 ? '(none)' : JSON.stringify(text.slice(0, 120)));
  for (const block of ended) console.log('  call        :', block.block.name, block.block.arguments);

  return { chunks, started, deltas, ended, finish, text };
}

try {
  // --- turn 1: the model must ask for the tool -------------------------------
  const base = [
    { role: 'system', content: [{ type: 'text', text: 'You are a coding agent. To run a command you call the pwsh tool, exactly once.' }] },
    { role: 'user', content: [{ type: 'text', text: 'List the files in the current directory.' }] }
  ];

  const first = await turn(base, 'turn 1 (expect a pwsh call)');
  if (first.failure !== undefined) outcome.fail('turn 1 threw');
  if (first.started.length === 0) outcome.fail('turn 1 opened no tool-call block');
  if (first.deltas.length === 0) outcome.fail('turn 1 streamed no argument fragments');
  if (first.ended.length === 0) outcome.fail('turn 1 closed no tool-call block');
  if (first.finish?.reason?.kind !== 'tool-calls') outcome.fail(`turn 1 finished as ${first.finish?.reason?.kind}`);

  const call = first.ended[0]?.block;
  if (call === undefined) {
    outcome.fail('no call to answer, so the loop cannot be closed');
  } else {
    let parsed;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      outcome.fail(`the arguments are not JSON: ${String(call.arguments).slice(0, 120)}`);
    }
    if (parsed !== undefined && typeof parsed.command !== 'string') {
      outcome.fail('the arguments carry no command');
    }

    // --- turn 2: the exchange must survive being replayed ------------------
    // These are the harness's own shapes: the assistant turn holds the call as a
    // content block, and the result is a `tool` message keyed by `toolCallId`.
    const history = [
      ...base,
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }],
        source: { kind: 'model', provider: 'workbuddy', model }
      },
      {
        role: 'tool',
        toolCallId: call.id,
        content: [{ type: 'text', text: 'README.md\npackage.json' }],
        isError: false
      }
    ];

    const second = await turn(history, 'turn 2 (expect prose about the listing)');
    if (second.failure !== undefined) outcome.fail('turn 2 threw — the replayed exchange was rejected');
    if (second.finish?.reason?.kind !== 'stop') outcome.fail(`turn 2 finished as ${second.finish?.reason?.kind}`);
    if (second.text.trim().length === 0) outcome.fail('turn 2 produced no prose');
  }
} finally {
  await session.close();
}

outcome.pass();
