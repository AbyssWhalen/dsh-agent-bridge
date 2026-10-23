/**
 * Drive ONE model through ONE real turn, the way the harness does.
 *
 * Exists because `tools/real-loop-capture.ps1` runs a single model per invocation and reports
 * one verdict for the whole agent loop. Answering "does every advertised model work?" needs a
 * per-model verdict, and it needs the *reason* a model failed to be attributable: an empty
 * answer, a leaked call, a quota notice and a 404 all look the same from a transcript that only
 * says the tool did not run.
 *
 * Usage:
 *   node tools/model-probe.mjs --provider workbuddy --model deepseek-v4.1-flash
 *   node tools/model-probe.mjs --provider workbuddy --list
 *
 * Prints one JSON line. Exits 0 whatever the verdict — a failing model is data, not a crash.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBridge } from './probe-loader.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const provider = arg('provider', 'workbuddy');
const model = arg('model', '');
const prompt = arg('prompt', 'Reply with exactly the two words: ready now.');

/** One JSON line, whatever happens. */
const report = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const scratch = mkdtempSync(join(tmpdir(), 'dsh-probe-'));

let bridge;
try {
  bridge = await loadBridge();
} catch (error) {
  report({ provider, model, verdict: 'BRIDGE', detail: String(error?.message ?? error) });
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

const { runtime } = bridge;

try {
  if (flag('list')) {
    const adapter = await runtime.waitFor(provider);
    if (adapter === undefined) {
      report({ provider, verdict: 'NO_ADAPTER' });
      rmSync(scratch, { recursive: true, force: true });
      process.exit(0);
    }
    // The advertised list, after its bounded wait: `listModels` itself is synchronous and reads
    // whatever the catalog holds, so asking before the first refresh lands would report zero
    // models for a perfectly healthy vendor.
    const models = await adapter.listModels(provider);
    report({ provider, verdict: models.length === 0 ? 'NO_MODELS' : 'LISTED', count: models.length, models });
    rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
  }

  if (model.length === 0) {
    report({ provider, verdict: 'NO_MODEL', detail: 'pass --model' });
    rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
  }

  const adapter = await runtime.waitFor(provider);
  if (adapter === undefined) {
    report({ provider, model, verdict: 'NO_ADAPTER' });
    rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
  }

  const target = await adapter.resolveModel(provider, model);
  const started = Date.now();
  let text = '';
  let reasoning = 0;
  let finish;
  let usage;
  let failure;
  let chunks = 0;

  // A ceiling low enough that a chatty model still lands inside it, high enough that a real
  // answer fits. A probe that runs the model out of budget measures the ceiling, not the model.
  try {
    for await (const chunk of adapter.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      ...(Number(process.env['PROBE_MAX_TOKENS'] ?? '256') > 0 ? { maxTokens: Number(process.env['PROBE_MAX_TOKENS']) } : {})
    })) {
      chunks += 1;
      if (chunk.type === 'text-delta') text += chunk.text ?? '';
      else if (chunk.type === 'reasoning-delta') reasoning += 1;
      else if (chunk.type === 'finish') finish = chunk.reason;
      else if (chunk.type === 'usage') usage = chunk.usage;
      else if (chunk.type === 'error') failure = chunk.error;
    }
  } catch (error) {
    failure = error?.failure ?? { code: error?.code ?? 'THROWN', message: String(error?.message ?? error) };
  }

  report({
    provider,
    model,
    verdict: failure === undefined ? 'OK' : 'FAILED',
    ms: Date.now() - started,
    contextWindow: target?.context?.contextWindow ?? null,
    defaultMaxTokens: target?.defaultMaxTokens ?? null,
    finish: finish?.kind ?? null,
    chunks,
    textLength: text.length,
    textHead: text.slice(0, 160),
    reasoningDeltas: reasoning,
    usage: usage ?? null,
    failure: failure ?? null
  });
} catch (error) {
  report({ provider, model, verdict: 'THREW', detail: String(error?.message ?? error) });
} finally {
  try {
    await runtime.close?.();
  } catch {
    // Teardown failures are not this probe's verdict.
  }
  rmSync(scratch, { recursive: true, force: true });
}
