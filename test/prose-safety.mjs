/**
 * The guard must not eat correct answers.
 *
 * Every test in this directory before this file asked "does the leak get through?". None asked
 * the opposite, and that blindness cost a real regression: `truncateOpenMarkup` cut at the last
 * `<` unconditionally, so an ordinary reply containing a comparison lost everything after it —
 *
 *     If x < y then swap them.        ->  If x
 *     Range: 0 < n < 100.             ->  Range: 0 < n
 *     变量 x < y 时交换。             ->  变量 x
 *
 * — while the whole suite stayed green. A guard that deletes the model's answer is worse than
 * the display glitch it was added to prevent: the glitch is visible and rare, the deletion is
 * silent and certain for anyone writing about code, maths or ranges.
 *
 * So this file states the property that has to hold forever:
 *
 *     text that contains no call markup comes out of the guard byte-identical.
 *
 * The balancing property — that real markup is still removed — is checked in the same file,
 * because either half alone is trivially satisfiable by doing nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasNativeLeak, scrubForReplay, truncateOpenMarkup } from '../lib/dsml.js';

const B = '\uFF5C';

/** Prose a model plausibly writes. None of it is markup, so none of it may change. */
const PROSE = [
  'If x < y then swap them.',
  'The result is 5 < 10, obviously.',
  'Range: 0 < n < 100.',
  'Compare a<b.',
  '变量 x < y 时交换。',
  'If n < 10 handle it, else loop.',
  'Sort ascending, where a < b.',
  'Use <div> for the wrapper.',
  'The operator < is less-than.',
  'The cost is < 5 dollars.',
  'Less than < 3 items remain.',
  'For every element e < limit, skip it.',
  'A pointer of type <T> is generic.',
  'Array<T> and Map<K, V> are different.',
  'See https://example.com/a?b=1 for details.',
  'Write it as x -> y, not x => y.',
  'Use `a <= b` for the inclusive check.',
  'No markup here at all.',
  ''
];

/** Minimal shapes that really are unterminated call markup and must not reach the screen. */
const MARKUP = [
  `<${B}${B}DSML${B}${B}invoke name="pwsh"><${B}${B}DSML${B}${B}parameter name="command">Get-D`,
  '< tool_call name="pwsh">< parameter name="command">Get-D',
  "<\ttool_call name='pwsh'>",
  '<antml name="pwsh">',
  '[tool call: pwsh {"command":"Get-D'
];

test('prose survives the guard untouched', () => {
  const damaged = [];
  for (const prose of PROSE) {
    const out = scrubForReplay(prose);
    if (out !== prose) damaged.push({ prose, out });
  }
  assert.deepEqual(damaged, [], `the guard altered text that carries no markup:\n${damaged.map((d) => `  ${JSON.stringify(d.prose)} -> ${JSON.stringify(d.out)}`).join('\n')}`);
});

test('the same prose survives the truncation step alone', () => {
  // Truncation is where the damage happened, so it is asserted where the bug was. Checking
  // only the composition would leave the culprit free to change shape behind a green test.
  const damaged = PROSE.filter((prose) => truncateOpenMarkup(prose) !== prose);
  assert.deepEqual(damaged, [], `truncateOpenMarkup cut ordinary prose: ${JSON.stringify(damaged)}`);
});

test('real markup is still removed', () => {
  const survived = MARKUP.filter((markup) => hasNativeLeak(scrubForReplay(markup)));
  assert.deepEqual(survived, [], `markup reached the output:\n${survived.map((m) => `  ${JSON.stringify(scrubForReplay(m))}`).join('\n')}`);
  // And the prose that preceded a block is kept: that text is the model's own answer. Trailing
  // whitespace is compared loosely — `stripLeak` only trims on the path that actually deleted
  // something, and a space left behind is not the defect this file is about.
  assert.equal(scrubForReplay(`Checking first. ${MARKUP[0]}`).trim(), 'Checking first.');
});

test('the two properties hold together over generated input', () => {
  // Deterministic, and generated rather than listed: the regression above was a shape nobody
  // had written down, and a list cannot contain what nobody thought of.
  let state = 0x1234abcd;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];

  const failures = [];
  for (let i = 0; i < 4000 && failures.length < 5; i++) {
    // Half the cases are pure prose, half are prose with a marker appended.
    const words = pick(PROSE);
    const withMarker = random() < 0.5 ? `${words}${pick(MARKUP)}` : words;
    const out = scrubForReplay(withMarker);

    // Whatever came out carries no complete or half-open markup.
    if (hasNativeLeak(out)) {
      failures.push({ kind: 'markup survived', input: withMarker, out });
      continue;
    }
    // A pure-prose case must be byte-identical, since there was nothing to remove.
    if (withMarker === words && out !== words) {
      failures.push({ kind: 'prose altered', input: words, out });
    }
  }
  assert.deepEqual(failures, [], `invariant violated:\n${failures.map((f) => `  ${f.kind}: ${JSON.stringify(f.input)} -> ${JSON.stringify(f.out)}`).join('\n')}`);
});
