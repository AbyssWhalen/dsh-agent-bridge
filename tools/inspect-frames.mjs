/**
 * Read a frame dump and report every call-syntax fragment the driver would have to
 * deal with, with code points.
 *
 * The terminal is a lossy view: `<｜｜｜｜｜｜invoke` could be six fullwidth bars, six ASCII
 * bars, or bars with a tag name the regex never expected. Deciding whether the parser
 * has a gap needs the characters themselves.
 *
 * Run with `node tools/inspect-frames.mjs <dump.jsonl>`.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (path === undefined) {
  console.log('usage: inspect-frames.mjs <dump.jsonl>');
  process.exit(2);
}

const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
let answer = '';
let thinking = '';
const resultFrames = [];

for (const line of lines) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    continue;
  }
  if (frame?.type === 'result') resultFrames.push(frame);
  for (const event of [frame, frame.event]) {
    if (event?.delta?.type === 'text_delta') answer += event.delta.text;
    if (event?.delta?.type === 'thinking_delta') thinking += event.delta.thinking;
  }
}

/** Render the characters around every `<` that is followed by a non-ASCII bar. */
function inspect(label, value) {
  console.log(`\n${label}: ${value.length} chars`);
  let found = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '<') continue;
    const slice = value.slice(index, index + 40);
    if (!/[\uFF5C|]/u.test(slice.slice(1, 8))) continue;
    found += 1;
    if (found > 8) break;
    const points = [...slice]
      .slice(0, 14)
      .map((character) => {
        const point = character.codePointAt(0);
        return point > 0x7f ? `U+${point.toString(16).toUpperCase()}` : JSON.stringify(character);
      })
      .join(' ');
    console.log(`  ${JSON.stringify(slice.slice(0, 30))}`);
    console.log(`    ${points}`);
  }
  if (found === 0) console.log('  (no bar-delimited tags)');
}

inspect('answer text', answer);
inspect('reasoning', thinking);

const last = resultFrames[resultFrames.length - 1];
console.log(`\nresult frames: ${resultFrames.length}`);
if (last !== undefined) {
  console.log(`  last: subtype=${String(last.subtype)} is_error=${String(last.is_error)}`);
}
