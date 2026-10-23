/**
 * Call every advertised model once and summarise the verdicts.
 *
 * `model-probe.mjs` measures one model; this walks the catalog. It exists because the question
 * "can DSH actually use these?" is asked per vendor and answered per model: one bad entry in
 * twenty is exactly the case a single-model smoke test cannot see, and it is also the case that
 * makes a model picker look broken to a user.
 *
 * Usage:
 *   node tools/model-sweep.mjs --provider workbuddy
 *   node tools/model-sweep.mjs --provider qoder --only auto,fast
 *
 * Prints one JSON line per model, then a summary line. Never exits non-zero — a failing model is
 * a finding, not a crash.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const provider = arg('provider', 'workbuddy');
const only = arg('only', '');
const concurrency = Number(arg('concurrency', '3'));
const here = fileURLToPath(new URL('.', import.meta.url));

/** One probe run, resolving to its parsed JSON line. */
function probe(model) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(here, 'model-probe.mjs'), '--provider', provider, '--model', model],
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        const line = String(stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
        if (line === undefined) {
          resolve({ provider, model, verdict: 'NO_OUTPUT', detail: String(error?.message ?? '') });
          return;
        }
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ provider, model, verdict: 'UNPARSED', detail: line.slice(0, 200) });
        }
      }
    );
  });
}

const list = await new Promise((resolve) => {
  execFile(
    process.execPath,
    [join(here, 'model-probe.mjs'), '--provider', provider, '--list'],
    { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout) => {
      const line = String(stdout ?? '').trim().split('\n').filter(Boolean).at(-1);
      try {
        resolve(JSON.parse(line).models ?? []);
      } catch {
        resolve([]);
      }
    }
  );
});

if (list.length === 0) {
  process.stdout.write(`${JSON.stringify({ provider, verdict: 'NO_MODELS' })}\n`);
  process.exit(0);
}

const wanted = only.length === 0 ? list.map((row) => row.id) : only.split(',').map((id) => id.trim()).filter(Boolean);
const queue = [...wanted];
const results = [];

// Bounded fan-out: these are real upstream calls against a real account, so a burst of twenty at
// once would look like abuse to the vendor and would also make a rate-limit verdict
// indistinguishable from a per-model one.
const worker = async () => {
  while (queue.length > 0) {
    const model = queue.shift();
    if (model === undefined) return;
    const result = await probe(model);
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
};

await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));

const byVerdict = new Map();
for (const result of results) byVerdict.set(result.verdict, (byVerdict.get(result.verdict) ?? 0) + 1);

process.stdout.write(
  `${JSON.stringify({
    provider,
    asked: wanted.length,
    verdicts: Object.fromEntries(byVerdict),
    failed: results
      .filter((row) => row.verdict !== 'OK')
      .map((row) => ({ model: row.model, verdict: row.verdict, code: row.failure?.code ?? null, message: (row.failure?.message ?? row.detail ?? '').slice(0, 180) }))
  })}\n`
);
