/**
 * Offline: what a replayed or appended turn actually puts in front of the child.
 *
 * `QoderConversation` has two ways to say what is new: append the tail, or replay the
 * transcript. Both were wrong in ways no reply can show, and both are byte-level facts,
 * so this pins the bytes.
 *
 * **The replay used to lose the call.** `flattenConversation` drops everything after the
 * last user turn, because the tail is normally repeated as the instruction. Replaying
 * into a child that has **no history** — freshly spawned, or replaced after a crash —
 * that truncation removed the only record that a tool had run. The child received a
 * bare result:
 *
 *     [Conversation so far]
 *     User: List the files in C:\missing-folder using the pwsh tool.
 *     [End of conversation so far]
 *
 *     Get-ChildItem : Cannot find path 'C:\missing-folder' because it does not exist.
 *
 * Read by a model, that is the user reporting a path problem. The call id, the tool
 * name and the fact that this was output at all are gone. Verified live afterwards:
 * with the call present the model answers "The command returned the following error",
 * which is the reading the truncated prompt could not support.
 *
 * **The append never happened for a tool result.** The guard required the new tail to
 * end with a user message, so the turn answering a tool result always replayed. Every
 * exchange paid for a transcript rebuild, and the rebuild is what lost the call.
 *
 * Run with `node test/replay-shape.mjs`.
 */
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QoderConversation } from '../drivers/qoder/conversation.js';
import { isStraightAppend, messageFingerprint } from '../lib/messages.js';

const runtimePath = fileURLToPath(new URL('./fake-measuring-runtime.mjs', import.meta.url));
const tools = [
  { name: 'pwsh', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
];

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Run however many turns a scenario needs, and return every prompt the child received.
 *
 * @param {{turns: {messages: object[], reply?: string}[]}} scenario
 */
async function record(scenario) {
  const logPath = join(tmpdir(), `replay-shape-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  rmSync(logPath, { force: true });
  process.env.FAKE_MEASURE_LOG = logPath;
  // One reply per turn; a leaked call keeps a loop advancing, prose closes it.
  process.env.FAKE_REPLY_FRAMES = scenario.turns.map((turn) => turn.reply ?? 'done').join('|||');

  const conversation = new QoderConversation({
    runtimePath,
    sdkVersion: undefined,
    cwd: process.cwd(),
    resolveCredential: async () => ({ token: 'x' }),
    logger: { debug: () => {}, info: () => {}, warn: () => {} }
  });

  try {
    for (const turn of scenario.turns) {
      for await (const chunk of conversation.send(turn.messages, { model: 'fake-model-1', effort: 'low', tools })) {
        void chunk;
      }
    }
  } finally {
    await conversation.close();
  }

  const entries = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  rmSync(logPath, { force: true });

  return {
    framing: entries.filter((entry) => entry.kind === 'framing'),
    prompts: entries.filter((entry) => entry.kind === 'prompt')
  };
}

const system = { role: 'system', text: 'You are a coding agent.' };
const ask = { role: 'user', text: 'List the files in C:\\missing-folder.' };
const call = (id) => ({
  role: 'assistant',
  content: [{ type: 'tool-call', id, name: 'pwsh', arguments: '{"command":"Get-ChildItem"}' }]
});
const result = (id, text) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }] });

console.log('# a fresh child handed a tool result\n');

{
  const { prompts } = await record({
    turns: [{ messages: [system, ask, call('call_1'), result('call_1', 'Cannot find path C:\\missing-folder')] }]
  });
  const prompt = prompts[0]?.text ?? '';
  check('the call that produced the result is in the prompt', () => {
    assert(/\[tool call: pwsh/u.test(prompt), `no call in: ${JSON.stringify(prompt)}`);
  });
  check('the call id is in the prompt, so the pairing is legible', () => {
    assert(/call_1/u.test(prompt), `no id in: ${JSON.stringify(prompt)}`);
  });
  check('the result is labelled as a tool result', () => {
    assert(/Tool result for call_1/u.test(prompt), `result unlabelled in: ${JSON.stringify(prompt)}`);
  });
  check('the result body itself survives', () => {
    assert(prompt.includes('Cannot find path'), `output missing from: ${JSON.stringify(prompt)}`);
  });
  check('the user turn is still there', () => {
    assert(/User: List the files/u.test(prompt), `no user turn in: ${JSON.stringify(prompt)}`);
  });
}

console.log('\n# a tool result on a child that already has the history\n');

{
  const { prompts } = await record({
    turns: [
      { messages: [system, ask], reply: 'markup' },
      { messages: [system, ask, call('call_2'), result('call_2', 'alpha.txt\nbeta.txt')] }
    ]
  });
  const second = prompts[1];
  check('the result is appended, not replayed', () => {
    assert(second !== undefined, 'no second prompt');
    assert(!second.replay, `replayed anyway: ${JSON.stringify(second.text)}`);
  });
  check('and it is tiny — no transcript rides along', () => {
    assert(second.bytes < 200, `${second.bytes} bytes: ${JSON.stringify(second.text)}`);
  });
  check('it still names the call it answers', () => {
    assert(/Tool result for call_2/u.test(second.text), `unlabelled: ${JSON.stringify(second.text)}`);
  });
  check('it does not echo the call back as if the user said it', () => {
    assert(!/\[tool call:/u.test(second.text), `echoed: ${JSON.stringify(second.text)}`);
  });
}

console.log('\n# a plain question with no history\n');

{
  const { prompts } = await record({ turns: [{ messages: [system, { role: 'user', text: 'hello there' }] }] });
  check('the question is sent bare, with no transcript wrapper', () => {
    assert(prompts[0]?.text === 'hello there', `got ${JSON.stringify(prompts[0]?.text)}`);
  });
}

console.log('\n# a diverged history is replayed in full\n');

{
  const { prompts } = await record({
    turns: [
      { messages: [system, ask], reply: 'markup' },
      // The earlier user turn was edited, so nothing can be appended.
      { messages: [system, { role: 'user', text: 'A different question entirely.' }, call('call_3'), result('call_3', 'x')] }
    ]
  });
  const second = prompts[1];
  check('the divergence forces a replay', () => {
    assert(second?.replay === true, `appended anyway: ${JSON.stringify(second?.text)}`);
  });
  check('and the replay is faithful — the call is present', () => {
    assert(/\[tool call: pwsh/u.test(second.text), `no call: ${JSON.stringify(second.text)}`);
    assert(/Tool result for call_3/u.test(second.text), `no labelled result: ${JSON.stringify(second.text)}`);
  });
}

console.log('\n# the append guard\n');

{
  const previous = [{ role: 'user', text: 'q1' }].map(messageFingerprint);
  check('a trailing user turn appends', () => {
    assert(isStraightAppend(previous, [{ role: 'user', text: 'q1' }, { role: 'user', text: 'q2' }]), 'refused');
  });
  check('a trailing tool result appends', () => {
    const next = [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: '' },
      { role: 'tool', text: 'output' }
    ];
    assert(isStraightAppend(previous, next), 'refused');
  });
  check('a user turn in the middle does not append', () => {
    const next = [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: '' },
      { role: 'user', text: 'q2' },
      { role: 'tool', text: 'output' }
    ];
    assert(!isStraightAppend(previous, next), 'appended across two user turns');
  });
  check('a changed prefix does not append', () => {
    assert(!isStraightAppend(previous, [{ role: 'user', text: 'edited' }, { role: 'user', text: 'q2' }]), 'appended');
  });
  check('nothing new does not append', () => {
    assert(!isStraightAppend(previous, [{ role: 'user', text: 'q1' }]), 'appended nothing');
  });
}

console.log('');
if (failures > 0) {
  console.log(`# replay-shape: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# replay-shape: OK');
