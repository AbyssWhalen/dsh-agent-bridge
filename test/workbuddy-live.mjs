/**
 * Live acceptance test for the WorkBuddy driver.
 *
 * Exercises the whole path against the real desktop app's sign-in and the real
 * upstream: locate, catalog, normalize, credits, then a streaming turn and a
 * second turn that carries the first one's answer back as history.
 *
 * Run with `node test/workbuddy-live.mjs`. Exits non-zero when the app is not
 * signed in, when no model survives normalization, or when a turn produces no
 * text — each of those is a finding, not a flake.
 */
import { driver } from '../drivers/workbuddy/index.js';
import { flattenConversation, normalizeMessages } from '../lib/messages.js';
import { verdict } from './verdict.mjs';

const outcome = verdict('WorkBuddy');

const system = 'You are a terse assistant. Follow the instruction exactly and reply with nothing else.';
const first = 'Reply with exactly: PONG';
const second = 'Now reply with exactly: PING';

function line(label, value) {
  console.log(`${label.padEnd(14)} ${value}`);
}

const located = await driver.locate();
line('locate', JSON.stringify(located));
if (!located.signedIn) {
  outcome.fail('WorkBuddy is not signed in; sign in through the desktop app');
}

const raw = await driver.listModels();
line('raw models', String(raw.length));
for (const model of raw) {
  const reasoning = model.reasoning ?? {};
  line(
    `  ${model.id}`,
    `ctx=${model.contextWindow} max=${model.maxTokens} ` +
      `reasoning=${reasoning.supports === true} efforts=${JSON.stringify(reasoning.supportedEfforts ?? null)} ` +
      `default=${reasoning.defaultEffort ?? '-'} off=${reasoning.canDisableThinking === true} ` +
      `credits=${model.billing?.credits ?? '-'} free=${model.billing?.free === true}`
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

const quota = await driver.quota({ fresh: true });
line('quota', JSON.stringify(quota));
line('quota text', String(driver.formatQuota(quota)));

const target =
  rows.find((row) => Array.isArray(row.efforts) && row.efforts.includes('low')) ??
  rows.find((row) => row.reasoning === true) ??
  rows[0];
const effort = Array.isArray(target.efforts) && target.efforts.includes('low') ? 'low' : undefined;
line('turn model', target.id);
line('turn effort', String(effort));

async function turn(messages, label) {
  // A free-tier account queues. Waiting out the upstream's own `retry_after` is
  // the caller's job — the driver reports the wait rather than absorbing it, since
  // retry policy belongs to the host.
  for (let attempt = 1; ; attempt += 1) {
    const session = await driver.openSession({ key: 'live' });
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
    } catch (error) {
      if (error?.kind === 'soft_rate' && attempt <= 12) {
        const waitSec = Math.min(120, (error.retryAfterSec ?? 30) + 5);
        console.log(`  queued (attempt ${attempt}): ${error.message} — waiting ${waitSec}s`);
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        continue;
      }
      throw error;
    } finally {
      await session.close();
    }
    console.log(`\n${label}: chunks=${[...new Set(chunks)].join(',')}`);
    line('  text', JSON.stringify(text));
    if (reasoning !== '') line('  reasoning', JSON.stringify(reasoning.slice(0, 200)));
    if (usage !== undefined) line('  usage', JSON.stringify(usage));
    return text;
  }
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

outcome.pass();
