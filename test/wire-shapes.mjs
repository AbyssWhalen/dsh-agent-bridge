/**
 * Offline: the wire body of a tool loop, for both message shapes.
 *
 * `toWireMessages` is reached with two different inputs, and only one of them is
 * the projection's output:
 *
 *   projected  `{ role, text, toolCalls: [...] }` — what `DriverAdapter.stream`
 *              hands a driver;
 *   raw        `{ role, content: [{ type: 'tool-call', … }] }` — what a caller that
 *              drives the conversation directly hands it.
 *
 * Reading only `toolCalls` used to make the second shape lose the assistant turn
 * entirely: the call's rendered `[tool call: …]` text was removed as leaked markup,
 * the message became empty, and it was dropped — leaving a `tool` result with no
 * call for it to answer, which the upstream refuses with
 * `11148 tool calls and tool results do not match`.
 *
 * Run with `node test/wire-shapes.mjs`.
 */
import { toWireMessages } from '../drivers/workbuddy/conversation.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const call = { id: 'call_1', name: 'pwsh', arguments: '{"command":"Get-ChildItem"}' };

/** The two answers exactly as the harness holds them. */
const projected = [
  { role: 'system', text: 'you are a coding agent' },
  { role: 'user', text: 'list the files' },
  { role: 'assistant', text: '', toolCalls: [call] },
  { role: 'tool', text: 'README.md', toolCallId: call.id }
];

const raw = [
  { role: 'system', content: [{ type: 'text', text: 'you are a coding agent' }] },
  { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }] },
  { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'README.md' }] }
];

for (const [label, messages] of [
  ['projected', projected],
  ['raw', raw]
]) {
  console.log(`\n${label} messages`);
  const wire = toWireMessages(messages, 'cn');
  const assistant = wire.find((message) => message.role === 'assistant');
  const result = wire.find((message) => message.role === 'tool');

  check('the assistant turn survives', assistant !== undefined);
  check(
    'it carries tool_calls, not prose',
    Array.isArray(assistant?.tool_calls) && assistant.tool_calls.length === 1,
    JSON.stringify(assistant?.tool_calls?.[0]?.function ?? null)
  );
  check('the call id is unchanged', assistant?.tool_calls?.[0]?.id === call.id, assistant?.tool_calls?.[0]?.id);
  check('the arguments are unchanged', assistant?.tool_calls?.[0]?.function?.arguments === call.arguments);
  check(
    'the rendered [tool call: …] text is not beside the structured call',
    typeof assistant?.content !== 'string' || !assistant.content.includes('[tool call'),
    JSON.stringify(assistant?.content ?? null)
  );
  check('the tool result still answers it by id', result?.tool_call_id === call.id, result?.tool_call_id);
  check('the tool result carries its text', result?.content === 'README.md', JSON.stringify(result?.content));
  check(
    'no message was silently dropped',
    wire.length === 4,
    `${wire.length} message(s): ${wire.map((message) => message.role).join(',')}`
  );
  if (assistant?.tool_calls?.[0] !== undefined && result === undefined) {
    check('a call without its result is not invented', false);
  }
}

// A plain conversation must still flatten the way it did before.
console.log('\nno tools anywhere');
const plain = toWireMessages(
  [
    { role: 'system', text: 'be terse' },
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi' },
    { role: 'user', text: 'again' }
  ],
  'cn'
);
check('the system turn leads', plain[0]?.role === 'system' && plain[0]?.content === 'be terse');
check('the turns keep their roles', plain.slice(1).every((message, index) => message.role === ['user', 'assistant', 'user'][index]));
check('no tool_calls are invented', plain.every((message) => message.tool_calls === undefined));

// A tool result whose call is gone must not become a bare `tool` message: the
// upstream rejects one that answers nothing.
console.log('\nan orphaned tool result');
const orphan = toWireMessages(
  [
    { role: 'system', text: 'be terse' },
    { role: 'user', text: 'hello' },
    { role: 'tool', text: 'stale output', toolCallId: 'call_gone' }
  ],
  'cn'
);
check('the orphan is not sent as an unanswered tool message', !orphan.some((message) => message.role === 'tool'));

const failed = results.filter((result) => !result.ok);
console.log(`\nwire-shapes: ${failed.length === 0 ? 'OK' : `${failed.length} FAILED`}`);
process.exit(failed.length === 0 ? 0 : 1);
