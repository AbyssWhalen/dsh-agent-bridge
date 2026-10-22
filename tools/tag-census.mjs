/**
 * Every tag-shaped fragment in a capture dump, grouped by the identifier that follows the
 * delimiter.
 *
 * The problem this exists for: a dialect that appears once in 130 live turns still costs a
 * turn every time it appears, and reading 130 transcripts by eye is not a method. Reading
 * failure logs is worse than useless here — the cheap check is a census over every frame
 * ever captured, and the question it answers is "is there a shape whose leading word the
 * grammar has never heard of".
 *
 * Run with `node tools/tag-census.mjs <dump.jsonl> [more.jsonl …]`.
 *
 * On the three dumps taken during the fourth and fifth rounds (471 fragments) the answer was
 * no: the words were only `dsml`, `invoke`, `ds`, `parameter`, `tooldsml`, `tool_name`,
 * `tool_call`. That is worth knowing — it means the capture set is not hiding a seventh
 * dialect, so effort belongs in the cleanup path rather than the grammar.
 *
 * Companion: `tools/residue-census.mjs`, which asks the harder question — whether markup
 * survives the cleanup applied to replayed history.
 */
import { readFileSync } from 'node:fs';
import { parseLeakedCalls } from '../lib/dsml.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('usage: tag-census.mjs <dump.jsonl> [more.jsonl ...]');
  process.exit(2);
}

const BARS = '[\\uFF5C|]';
// `<` then any run of bars and space glyphs, then the leading word.
const FRAGMENT = new RegExp(`<${BARS}{0,32}[\\u2581_]*([A-Za-z_]{0,16})`, 'gu');

const census = new Map();
let fragments = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    console.log(`skipped ${file}: ${error.message}`);
    continue;
  }
  for (const match of text.matchAll(FRAGMENT)) {
    // Only fragments that actually carry a delimiter: a bare `<b>` is not interesting.
    if (!new RegExp(BARS, 'u').test(match[0])) continue;
    fragments += 1;
    const word = match[1].toLowerCase();
    const entry = census.get(word) ?? { count: 0, recovered: 0, unrecognised: 0 };
    entry.count += 1;
    // The block this fragment belongs to: from the fragment to the next 2000 characters.
    // A window rather than a parse of the frame, because the point is the *word*, not the
    // call — `parseLeakedCalls` is only here to separate "the grammar saw this" from
    // "nothing in this window looked like a call".
    const { calls } = parseLeakedCalls(text.slice(match.index, match.index + 2000));
    if (calls.length > 0) entry.recovered += 1;
    else entry.unrecognised += 1;
    census.set(word, entry);
  }
}

console.log(`fragments: ${fragments} across ${files.length} file(s)\n`);
console.log('word'.padEnd(18), 'count'.padStart(6), 'recovered'.padStart(10), 'unrecognised'.padStart(13));
for (const [word, entry] of [...census.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(
    (word === '' ? '(none)' : word).padEnd(18),
    String(entry.count).padStart(6),
    String(entry.recovered).padStart(10),
    String(entry.unrecognised).padStart(13)
  );
}
