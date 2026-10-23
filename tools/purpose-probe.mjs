/**
 * Measures what the harness actually sends for each `purpose`, on a live turn.
 *
 * Why this exists: `lib/adapter.js` treats `session-title` specially (effort pinned to `off`) and
 * lets every other purpose through unchanged. That asymmetry was written from a measurement of
 * one purpose only. `compaction` shares the plumbing but not the measurement, and it is the one
 * that carries the entire transcript — so if it arrives with `reasoningEffort: 'high'` and no
 * `maxTokens` ceiling, a single compaction can cost more than the conversation it summarises.
 *
 * The probe wraps `apply()` the same way the host does (`tools/probe-loader.mjs`), then replaces
 * the adapter's `stream` with a pass-through that records the options it was handed before calling
 * the real one. Nothing about the plugin is modified and no repair is needed afterwards.
 *
 * Usage:
 *   node tools/purpose-probe.mjs --provider workbuddy --model deepseek-v4.1-flash --purpose compaction
 *   node tools/purpose-probe.mjs --provider workbuddy --model deepseek-v4.1-flash --purpose session-title
 *   node tools/purpose-probe.mjs --provider qoder --model dfmodel --purpose compaction
 *
 * Output: one JSON line describing the options that reached the adapter, plus the turn outcome.
 * The turn really runs, so this measures behaviour rather than a reconstructed shape.
 */
import process from 'node:process';
import { loadBridge } from './probe-loader.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const provider = flag('provider', 'workbuddy');
const model = flag('model', provider === 'qoder' ? 'dfmodel' : 'deepseek-v4.1-flash');
const purpose = flag('purpose', 'compaction');
const effort = flag('effort', undefined);
const maxTokens = flag('maxTokens', undefined);
const turns = Number(flag('turns', '4'));

/**
 * A transcript long enough that a compaction request is a real compaction request.
 *
 * The harness decides what to compact from the history it holds; a one-message probe would make
 * the measured `messages` length meaningless. These turns are cheap to produce because they are
 * only *sent*, not generated — the user side is synthetic text.
 */
function syntheticHistory(count) {
  const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `Step ${i + 1}: ${filler}` }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `Acknowledged step ${i + 1}. ${filler}` }] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Summarise what we have done so far.' }] });
  return messages;
}

const { runtime } = await loadBridge();
let seen = null;
try {
  const adapter = await runtime.waitFor(provider);

  // Wrap the registered adapter rather than the driver, so what is recorded is exactly what the
  // host hands the plugin — the same boundary that hid F-035 and F-036.
  const realStream = adapter.stream.bind(adapter);
  adapter.stream = (options) => {
    const keys = Object.keys(options).sort();
    const messages = Array.isArray(options.messages) ? options.messages : [];
    let characters = 0;
    let contentBlocks = 0;
    const roles = [];
    for (const message of messages) {
      roles.push(message?.role ?? '?');
      const content = message?.content;
      if (typeof content === 'string') characters += content.length;
      else if (Array.isArray(content)) {
        contentBlocks += content.length;
        for (const block of content) characters += typeof block?.text === 'string' ? block.text.length : 0;
      }
    }
    seen = {
      keys,
      purpose: options.purpose ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
      maxTokens: options.maxTokens ?? null,
      system: typeof options.system === 'string' ? options.system.length : options.system === undefined ? null : 'non-string',
      sessionId: options.sessionId === undefined ? null : 'present',
      tools: Array.isArray(options.tools) ? options.tools.length : options.tools === undefined ? null : 'non-array',
      messages: {
        count: messages.length,
        roles: roles.slice(0, 6),
        characters,
        contentBlocks
      }
    };
    return realStream(options);
  };

  const request = {
    provider,
    model,
    purpose,
    messages: syntheticHistory(turns)
  };
  if (effort !== undefined) request.reasoningEffort = effort;
  if (maxTokens !== undefined) request.maxTokens = Number(maxTokens);

  let chunks = 0;
  let text = '';
  let finishKind = null;
  let failure = null;
  const started = Date.now();
  try {
    for await (const chunk of adapter.stream(request)) {
      chunks += 1;
      if (chunk.type === 'text-delta') text += chunk.text ?? '';
      if (chunk.type === 'finish') finishKind = chunk.finish?.kind ?? null;
    }
  } catch (error) {
    failure = {
      message: String(error?.message ?? error),
      kind: error?.failure?.kind ?? error?.bridgeKind ?? null,
      code: error?.failure?.code ?? null
    };
  }

  console.log(
    JSON.stringify({
      provider,
      model,
      requestedPurpose: purpose,
      optionsSeenByAdapter: seen,
      ms: Date.now() - started,
      chunks,
      textLength: text.length,
      finish: finishKind,
      failure
    })
  );
} finally {
  await runtime.close();
}
