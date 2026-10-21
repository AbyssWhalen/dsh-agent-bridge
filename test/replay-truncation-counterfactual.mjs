/**
 * Counterfactual check: does the guard actually catch the defect it was written for?
 *
 * Every other suite asserts that the fixed code behaves. None of them asserts that the
 * assertion is load-bearing — a guard can pass for a reason unrelated to the defect, and
 * then keep passing after the fix is accidentally undone. `test/replay-shape.mjs` pinned
 * the history-replay defect (a cold child was handed a transcript truncated after the last
 * user turn, so it never saw the call it was asked to continue); the way to know that
 * suite still has teeth is to put the defect back and watch it go red.
 *
 * So this one deliberately breaks the source: `flattenTranscript` is swapped for the old
 * truncating behaviour, `test/replay-shape.mjs` is run, and the file is restored. The only
 * change made is the one under test, and it is always reverted — including on failure.
 *
 * This lives in `test/` rather than `_probe/` for exactly the reason above: a guard whose
 * guard is a throwaway script is not guarded. It is not part of `npm test` (it rewrites a
 * source file, which no test in a suite should do), but it is part of the repo, so the
 * next person who touches `flattenTranscript` can run it.
 *
 * Usage: node test/replay-truncation-counterfactual.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../lib/messages.js', import.meta.url));
const guard = fileURLToPath(new URL('./replay-shape.mjs', import.meta.url));
const original = readFileSync(target, 'utf8');

const from = `  if (messages.length === 1 && messages[0]?.role === 'user') return readText(messages[0]);\n  const lines = [];`;
const to = `  if (messages.length === 1 && messages[0]?.role === 'user') return readText(messages[0]);
  // COUNTERFACTUAL: drop everything after the last user turn, as the old code did.
  let cut = messages.length;
  while (cut > 0 && messages[cut - 1].role !== 'user') cut -= 1;
  {
    const kept = messages.slice(0, cut);
    const out = [];
    for (const message of kept) {
      const body = readText(message);
      if (body.length === 0) continue;
      out.push(\`\${roleLabel(message?.role)}: \${body}\`);
    }
    return out.length === 0
      ? readText(messages[messages.length - 1])
      : \`[Conversation so far]\\n\${out.join('\\n\\n')}\\n[End of conversation so far]\\n\${readText(messages[messages.length - 1])}\`;
  }
  const lines = [];`;

if (!original.includes(from)) {
  console.error('marker not found — lib/messages.js changed shape; update this counterfactual');
  process.exit(2);
}

let caught = false;
try {
  writeFileSync(target, original.replace(from, to));
  let output = '';
  let failed = false;
  try {
    output = execFileSync(process.execPath, [guard], { encoding: 'utf8' });
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  caught = failed;
  for (const line of output.split('\n').filter((line) => line.includes('FAIL') || line.includes('failed'))) {
    console.log(line.trim());
  }
} finally {
  writeFileSync(target, original);
  console.log('(source restored)');
}

console.log(caught ? '\nRESULT: the guard caught the truncation' : '\nRESULT: the guard did NOT catch the truncation');
process.exit(caught ? 0 : 1);
