/**
 * The whole spelling surface, as a property.
 *
 * Every previous round of this fix worked the same way: a leak was reported, one shape was
 * added to the parser, and the next report was a different shape. That is a losing loop,
 * because the knobs a model can turn are finite but nobody was enumerating them. This file
 * enumerates them — envelope, delimiter, opener, parameter, closer — takes the product, and
 * asserts that no combination leaves markup in the text channel.
 *
 * It is what found the closing-tag whitespace defect: `< / ｜｜DSML｜｜parameter>` and
 * `</ ｜｜parameter>` put the space on the other side of the slash, where the opener rule
 * could not see it, and 68% of the failing combinations came from that one space. Four
 * rounds of hand-written cases had not caught it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasNativeLeak, parseLeakedCalls } from '../lib/dsml.js';

const B = '\uFF5C';

/** How the delimiter can be spelled. A model drifts on the bar count and the letters. */
const DELIMITERS = {
  'two-bars-DSML': `${B}${B}DSML${B}${B}`,
  'one-bar-DSML': `${B}DSML${B}`,
  'three-bar-DSML': `${B}${B}${B}DSML${B}${B}${B}`,
  'ascii-DSML': '||DSML||',
  'mixed-bars': `|${B}DSML${B}|`,
  'bare-bars': `${B}${B}`,
  'spaced-DSML': `${B}${B} DSML ${B}${B}`,
  'no-delimiter': ''
};

const ENVELOPES = {
  calls: (d) => `<${d}calls>`,
  none: () => '',
  tool_calls: (d) => `<${d}tool_calls>`,
  antml: () => '<antml:function_calls>'
};

const OPENERS = {
  plain: (d) => `<${d}invoke name="pwsh">`,
  'space-after-lt': (d) => `< ${d}invoke name="pwsh">`,
  antml: () => '<antml:invoke name="pwsh">',
  function_call: () => '<function_call name="pwsh">',
  'unquoted-name': (d) => `<${d}invoke name=pwsh>`,
  'single-quoted-name': (d) => `<${d}invoke name='pwsh'>`
};

const PARAMS = {
  plain: (d) => `<${d}parameter name="command">Get-Date`,
  'string-true': (d) => `<${d}parameter name="command" string="true">Get-Date`,
  antml: () => '<antml:parameter name="command">Get-Date',
  'space-after-lt': (d) => `< ${d}parameter name="command">Get-Date`,
  'unquoted-name': (d) => `<${d}parameter name=command>Get-Date`
};

const CLOSERS = {
  full: (d) => `</${d}parameter></${d}invoke></${d}calls>`,
  'no-envelope-close': (d) => `</${d}parameter></${d}invoke>`,
  'space-after-slash': (d) => `</ ${d}parameter></ ${d}invoke>`,
  antml: () => '</antml:parameter></antml:invoke>',
  none: () => ''
};

/** Markup that survived into the text channel is the defect the user sees. */
const MARKUP_IN_TEXT = /invoke|parameter|calls|DSML|function_call|[｜|]{2}/iu;

test('no spelling combination leaves markup in the text channel', () => {
  const failures = [];
  let combinations = 0;

  for (const [envName, env] of Object.entries(ENVELOPES)) {
    for (const [dName, d] of Object.entries(DELIMITERS)) {
      for (const [opName, op] of Object.entries(OPENERS)) {
        for (const [paName, pa] of Object.entries(PARAMS)) {
          for (const [clName, cl] of Object.entries(CLOSERS)) {
            combinations += 1;
            const body = env(d) + op(d) + pa(d) + cl(d);
            const recognised = hasNativeLeak(body);
            const { rest } = parseLeakedCalls(body);
            if (!recognised || MARKUP_IN_TEXT.test(rest)) {
              failures.push(`${envName}/${dName}/${opName}/${paName}/${clName} recognised=${recognised} rest=${JSON.stringify(rest.slice(0, 60))}`);
            }
          }
        }
      }
    }
  }

  // 4 envelopes x 8 delimiter spellings x 6 openers x 5 parameters x 5 closers.\n  assert.equal(combinations, 4800, 'the sweep is meant to cover the whole product');
  assert.deepEqual(failures, [], `${failures.length} of ${combinations} combinations leak:\n${failures.slice(0, 12).join('\n')}`);
});

test('a fully closed block in any recognised spelling yields a usable call', () => {
  // The sweep above only checks that markup does not reach the user. This checks the other
  // half: that the call is actually recovered rather than silently dropped.
  const failures = [];
  for (const [dName, d] of Object.entries(DELIMITERS)) {
    for (const [opName, op] of Object.entries(OPENERS)) {
      if (opName === 'unquoted-name' || opName === 'single-quoted-name') continue;
      const body = op(d) + `<${d}parameter name="command">Get-Date</${d}parameter></${d}invoke>`;
      const { calls } = parseLeakedCalls(body);
      if (calls.length !== 1 || calls[0].name !== 'pwsh') {
        failures.push(`${dName}/${opName} -> ${calls.length} call(s)`);
      }
    }
  }
  assert.deepEqual(failures, [], `these spellings lost the call:\n${failures.join('\n')}`);
});

test('loosely spaced markup is still recognised as a whole', () => {
  // The specific defects the sweep found, kept as named cases so a future simplification
  // of the normalisation cannot quietly drop them.
  const cases = {
    'space after the closing slash': `<${B}${B}DSML${B}${B}calls><${B}${B}DSML${B}${B}invoke name="pwsh"><${B}${B}DSML${B}${B}parameter name="command">Get-Date</ ${B}${B}DSML${B}${B}parameter></ ${B}${B}DSML${B}${B}invoke>`,
    'bare bars with a spaced closer': `<${B}${B}calls><${B}${B}invoke name="pwsh"><${B}${B}parameter name="command">Get-Date</ ${B}${B}parameter></ ${B}${B}invoke>`,
    'mixed bar spellings': `<|${B}DSML${B}|calls><|${B}DSML${B}|invoke name="pwsh"><|${B}${B}DSML${B}|parameter name="command">Get-Date</|${B}DSML${B}|parameter></|${B}DSML${B}|invoke>`,
    'no delimiter, spaced opener': `< invoke name="pwsh">< parameter name="command">Get-Date</ parameter></ invoke>`
  };
  for (const [label, body] of Object.entries(cases)) {
    assert.equal(hasNativeLeak(body), true, `not recognised: ${label}`);
    const { calls, rest } = parseLeakedCalls(body);
    assert.equal(calls.length, 1, `no call recovered: ${label}`);
    assert.equal(calls[0].name, 'pwsh', `wrong name: ${label}`);
    assert.equal(MARKUP_IN_TEXT.test(rest), false, `markup left in text: ${label} -> ${JSON.stringify(rest)}`);
  }
});

test('prose with angle brackets and bars is not a call', () => {
  // The guard that this sweep's own fix broke once: an ASCII bar beside `<` is ordinary
  // arithmetic unless the word `DSML` is there to say otherwise.
  for (const prose of [
    'if (a < |b|) {}',
    'Compare x < y | 0 for the bitwise case.',
    'The rule is a < b | c > d.',
    'A table row reads | value > x here.',
    'Wrap it in <code>backticks</code>.',
    'Use `<invoke>` to start a call.'
  ]) {
    assert.equal(hasNativeLeak(prose), false, `false positive: ${JSON.stringify(prose)}`);
    assert.equal(parseLeakedCalls(prose).calls.length, 0, `invented a call from ${JSON.stringify(prose)}`);
  }
});
