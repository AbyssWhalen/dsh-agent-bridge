/**
 * The tool channel against the real upstream, through this plugin's own driver.
 *
 * `test/tools.mjs` proves the translator with synthetic SSE; this proves the same
 * path with a live account: the request carries `tools`, the model asks for one,
 * and the harness-shaped chunks come back reassembled.
 *
 * Run with `node test/tools-live.mjs [modelId]`.
 */
import { driver } from '../drivers/workbuddy/index.js';

const model = process.argv[2] ?? 'deepseek-v4.1-flash';

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

const messages = [
  { role: 'system', text: 'You are a coding agent. To run a command you call the pwsh tool.' },
  { role: 'user', text: 'List the files in the current directory.' }
];

const session = await driver.openSession({ key: 'tools-live' });
const chunks = [];
try {
  for await (const chunk of session.send(messages, { model, effort: 'low', tools })) chunks.push(chunk);
} finally {
  await session.close();
}

const started = chunks.filter((chunk) => chunk.type === 'block-start');
const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta');
const ended = chunks.filter((chunk) => chunk.type === 'block-end');
const finish = chunks.find((chunk) => chunk.type === 'finish');
const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');

console.log('chunk types :', [...new Set(chunks.map((chunk) => chunk.type))].join(', '));
console.log('block-start :', started.length, JSON.stringify(started.map((chunk) => chunk.blockType)));
console.log('deltas      :', deltas.length);
console.log('block-end   :', ended.length);
console.log('finish      :', JSON.stringify(finish?.reason));
console.log('text        :', text.length === 0 ? '(none — the turn is a call)' : JSON.stringify(text.slice(0, 80)));
for (const block of ended) {
  console.log('  call     :', block.block.name, block.block.arguments);
}

const ok =
  started.length > 0 &&
  deltas.length > 0 &&
  ended.length > 0 &&
  finish?.reason?.kind === 'tool-calls' &&
  ended.every((block) => {
    try {
      JSON.parse(block.block.arguments);
      return true;
    } catch {
      return false;
    }
  });

console.log(ok ? '\nWorkBuddy tool channel: OK' : '\nWorkBuddy tool channel: FAILED');
process.exit(ok ? 0 : 1);
