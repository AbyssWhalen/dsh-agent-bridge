/**
 * Live acceptance test for the Qoder driver.
 *
 * Qoder is the slowest vendor to reach: a cold worker runtime takes seconds to
 * authenticate before it will answer anything. So this test is deliberately
 * chatty about where it is, and it exercises the same path the plugin does —
 * locate, catalog, normalize, quota, a streaming turn, then a second turn on the
 * append path.
 *
 * Run with `node test/qoder-live.mjs`. Exits non-zero when the app is missing,
 * signed out, or a turn produces no text.
 */
import { driver } from '../drivers/qoder/index.js';
import { flattenConversation, normalizeMessages } from '../lib/messages.js';
import { verdict } from './verdict.mjs';

const outcome = verdict('Qoder');

const system = 'You are a terse assistant. Follow the instruction exactly and reply with nothing else.';
const first = 'Reply with exactly: PONG';
const second = 'Now reply with exactly: PING';

function line(label, value) {
  console.log(`${label.padEnd(14)} ${value}`);
}

function elapsed(start) {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

const located = await driver.locate();
line('locate', JSON.stringify(located));
if (!located.installed) {
  outcome.fail('Qoder is not installed');
}
if (!located.signedIn) {
  outcome.fail('Qoder is not signed in; sign in through the desktop app');
}

let start = Date.now();
const raw = await driver.listModels();
line('raw models', `${raw.length} (${elapsed(start)})`);
for (const model of raw) {
  line(
    `  ${model.id ?? model.modelId}`,
    `ctx=${model.contextWindow ?? '-'} max=${model.maxTokens ?? '-'} ` +
      `efforts=${JSON.stringify(model.reasoning?.supportedEfforts ?? model.reasoningEfforts ?? null)} ` +
      `default=${model.reasoning?.defaultEffort ?? model.defaultEffort ?? '-'}`
  );
}

const rows = raw.map((model) => driver.normalize(model)).filter((row) => row !== undefined);
line('normalized', String(rows.length));
if (rows.length === 0) {
  outcome.fail('no model survived normalization');
}
for (const row of rows) {
  line(`  ${row.id}`, `"${row.name}" efforts=${JSON.stringify(row.efforts ?? null)} default=${row.defaultEffort ?? '-'}`);
}

start = Date.now();
const quota = await driver.quota();
line('quota', `${JSON.stringify(quota)} (${elapsed(start)})`);
line('quota text', String(driver.formatQuota(quota)));

const target = rows.find((row) => Array.isArray(row.efforts) && row.efforts.includes('low')) ?? rows[0];
const effort = Array.isArray(target.efforts) && target.efforts.includes('low') ? 'low' : undefined;
line('turn model', target.id);
line('turn effort', String(effort));

async function turn(messages, label) {
  const session = await driver.openSession({ key: 'live' });
  const started = Date.now();
  const chunks = [];
  let text = '';
  let reasoning = '';
  let usage;
  try {
    for await (const chunk of session.send(messages, { model: target.id, effort })) {
      chunks.push(chunk.type);
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
      if (chunk.type === 'usage') usage = chunk.usage;
    }
  } finally {
    await session.close();
  }
  console.log(`\n${label}: chunks=${[...new Set(chunks)].join(',')} (${elapsed(started)})`);
  line('  text', JSON.stringify(text));
  if (reasoning !== '') line('  reasoning', JSON.stringify(reasoning.slice(0, 200)));
  if (usage !== undefined) line('  usage', JSON.stringify(usage));
  return text;
}

const history = [
  { role: 'system', content: system },
  { role: 'user', content: first }
];
const answer = await turn(history, 'turn 1');
if (answer.trim() === '') {
  outcome.fail('turn 1 produced no text');
}

const projected = normalizeMessages(history);
projected.push({ role: 'assistant', text: answer });
projected.push({ role: 'user', text: second });
line('\nreplay', JSON.stringify(flattenConversation(projected).slice(0, 120)));
await turn(projected, 'turn 2');

await driver.close();
outcome.pass();
