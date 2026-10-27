/**
 * The same spelling surface, but streamed one character at a time.
 *
 * The batch matrix cannot see a streaming defect: a block that parses correctly as a whole
 * can still reach the screen in fragments, because the hold is a separate rule from the
 * parser. That is exactly what F-066 was — every batch test green while one-character
 * deltas printed `<invoke name="pwsh">` to the user.
 *
 * So this walks each combination character by character and asserts that nothing is
 * released while it could still become markup. The instrument is the same function the
 * driver calls, so a hole here is a hole in the product.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endsWithMarkerPrefix, hasNativeLeak } from '../lib/dsml.js';

const B = '\uFF5C';

const DELIMITERS = {
  'two-bars-DSML': `${B}${B}DSML${B}${B}`,
  'one-bar-DSML': `${B}DSML${B}`,
  'ascii-DSML': '||DSML||',
  'mixed-bars': `|${B}DSML${B}|`,
  'bare-bars': `${B}${B}`,
  'spaced-DSML': `${B}${B} DSML ${B}${B}`,
  'no-delimiter': ''
};

const OPENERS = {
  plain: (d) => `<${d}invoke name="pwsh">`,
  'space-after-lt': (d) => `< ${d}invoke name="pwsh">`,
  antml: () => '<antml:invoke name="pwsh">',
  function_call: () => '<function_call name="pwsh">',
  unquoted: (d) => `<${d}invoke name=pwsh>`
};

const CLOSERS = {
  full: (d) => `</${d}parameter></${d}invoke>`,
  'space-after-slash': (d) => `</ ${d}parameter></ ${d}invoke>`
};

/**
 * Characters that may be released before the block is recognised.
 *
 * One trailing `>` is legitimate: at that instant the opener is complete, `hasNativeLeak`
 * is true, and the driver switches from holding to holding-the-block. The check below
 * only asks that the *prefix* was held, so the final character is allowed through.
 */
function releasedWhileForming(stream) {
  const released = [];
  let acc = '';
  for (let i = 0; i < stream.length; i++) {
    acc += stream[i];
    const atEnd = i === stream.length - 1;
    if (atEnd) continue;
    if (hasNativeLeak(acc)) break; // the block is recognised; the driver holds it from here
    if (!endsWithMarkerPrefix(acc)) released.push({ at: i, char: stream[i], sofar: acc.slice(-24) });
  }
  return released;
}

test('no spelling releases characters while the block is still forming', () => {
  const failures = [];
  let streams = 0;

  for (const [dName, d] of Object.entries(DELIMITERS)) {
    for (const [opName, op] of Object.entries(OPENERS)) {
      for (const [clName, cl] of Object.entries(CLOSERS)) {
        streams += 1;
        const stream = op(d) + `<${d}parameter name="command">Get-Date` + cl(d);
        const released = releasedWhileForming(stream);
        if (released.length > 0) {
          failures.push(`${dName}/${opName}/${clName}: released ${released[0].char === ' ' ? 'a space' : JSON.stringify(released[0].char)} at ${released[0].at}, tail ${JSON.stringify(released[0].sofar)}`);
        }
      }
    }
  }

  assert.equal(streams, 7 * 5 * 2, 'the sweep is meant to cover the whole product');
  assert.deepEqual(failures, [], `${failures.length} of ${streams} streams leak:\n${failures.slice(0, 10).join('\n')}`);
});

test('a delimiter split between two bars is held', () => {
  // The shape that started this: `<`, then one bar, then the rest.
  for (const prefix of [`<${B}`, `<${B}${B}`, `<${B}${B}DSML`, `<${B}${B}DSML${B}`, '<ant', '<antml:', '<antml:invo', '<inv', '<param', '<call']) {
    assert.equal(endsWithMarkerPrefix(prefix), true, `released too early: ${JSON.stringify(prefix)}`);
  }
});

test('ordinary text still releases immediately', () => {
  // The hold has to be narrow enough that a normal answer is not delayed.
  for (const text of ['Hello', 'The build passed', 'Use `code` here', 'a < b', 'x > y', 'done.']) {
    assert.equal(endsWithMarkerPrefix(text), false, `held ordinary text: ${JSON.stringify(text)}`);
  }
});

test('an angle bracket that is not markup releases', () => {
  // `<` alone is held (it could be the start of anything), but one ordinary character after
  // it settles the question.
  for (const text of ['a <b', 'if (a <b) {}', 'x <3', '5 <6']) {
    assert.equal(endsWithMarkerPrefix(text), false, `held prose: ${JSON.stringify(text)}`);
  }
});
