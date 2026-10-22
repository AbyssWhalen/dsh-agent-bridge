/**
 * Find frames where call markup survives cleanup.
 *
 * The harder question than `tools/tag-census.mjs`, and the one that found a real defect while
 * looking for nothing in particular: take every assistant text frame ever captured, run the
 * same cleanup the driver runs on replayed history, and check whether any delimiter character
 * is still there.
 *
 * Why it matters: recovering a call fixes the turn in front of you. Markup left in *history*
 * is an example the model copies next turn, so a single surviving tail propagates. And this
 * class of defect does not show up in a pass/fail count — the call itself succeeded in every
 * one of the eight strings that had residue.
 *
 * Run with `node tools/residue-census.mjs <dump.jsonl> [more.jsonl …]`.
 *
 * On the three dumps taken during the fourth and fifth rounds: 6502 frames, 93 strings
 * carrying markup, **8 with markup surviving `stripLeak`**. All eight were the same shape — a
 * closing tag repeated until the budget ran out, the last repetition truncated mid-tag. After
 * the fix: 0.
 *
 * A non-zero `markup blocks yielding no call` count is usually *not* a defect: streamed deltas
 * legitimately arrive as half a marker (`<｜tool_name`, `<｜DSML`), and for those the correct
 * outcome is an empty `rest` with no call. Check `rest` before believing it.
 */
import { readFileSync } from 'node:fs';
import { hasLeak, parseLeakedCalls, stripLeak } from '../lib/dsml.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('usage: residue-census.mjs <dump.jsonl> [more.jsonl ...]');
  process.exit(2);
}

let frames = 0;
let withMarkup = 0;
let survives = 0;
let recoveredNothing = 0;
const leftOver = new Map();
const samples = [];

/** Every string field that could hold model output. */
function collect(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) collect(value[key], out);
  }
}

for (const file of files) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch (error) {
    console.log(`skipped ${file}: ${error.message}`);
    continue;
  }
  for (const line of lines) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    frames += 1;
    const strings = [];
    collect(frame, strings);
    for (const value of strings) {
      if (!hasLeak(value)) continue;
      withMarkup += 1;
      const stripped = stripLeak(value);
      if (/[\uFF5C\u2581]/u.test(stripped)) {
        survives += 1;
        const key = stripped.match(/[\uFF5C\u2581]+[A-Za-z_]{0,16}/gu)?.[0] ?? '(?)';
        leftOver.set(key, (leftOver.get(key) ?? 0) + 1);
        if (samples.length < 3) samples.push({ raw: value.slice(0, 400), stripped: stripped.slice(0, 200) });
      }
      if (parseLeakedCalls(value).calls.length === 0) recoveredNothing += 1;
    }
  }
}

console.log(`frames: ${frames}`);
console.log(`strings carrying markup: ${withMarkup}`);
console.log(`markup surviving stripLeak: ${survives}`);
console.log(`markup blocks yielding no call: ${recoveredNothing}`);
if (leftOver.size > 0) {
  console.log('\nleft over:');
  for (const [key, count] of [...leftOver.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)}  ${JSON.stringify(key)}`);
  }
  console.log('\nsamples:');
  for (const sample of samples) {
    console.log('  raw     :', JSON.stringify(sample.raw));
    console.log('  stripped:', JSON.stringify(sample.stripped));
  }
}
