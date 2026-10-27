/**
 * History replay must not teach the model its own markup.
 *
 * Every streaming guard in this plugin stops a *new* leak. None of them can do anything
 * about a leak already stored: a session that ran before the fix has markup sitting in its
 * assistant turns as ordinary text, and every later turn replays it. The model reads its
 * own tags back, treats them as the house style, and writes them again — so one leak makes
 * the next hundred turns likelier to leak. That loop is what "it keeps happening" looks
 * like from the outside, and scrubbing history is the only thing that breaks it.
 *
 * Measured before the fix: `flattenTranscript`, `flattenConversation` and `appendPrompt`
 * each replayed a stored `<｜｜DSML｜｜invoke …>` block verbatim.
 *
 * The boundary these tests hold is asymmetric on purpose: assistant turns are scrubbed,
 * user turns are not. A user asking what the syntax means is writing *about* it, and those
 * words are the whole point of their message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { appendPrompt, flattenConversation, flattenTranscript } from '../lib/messages.js';

const B = '\uFF5C';
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const result = (id, text) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text }] });

/** Anything that came from the wire format rather than from the model's own words. */
const MARKUP = /[｜|]{2}|DSML|<invoke|<parameter|\[tool call/iu;

/** The shapes a pre-fix session can have stored. */
const LEAKS = {
  'native DSML': `<${B}${B}DSML${B}${B}invoke name="pwsh"><${B}${B}DSML${B}${B}parameter name="command">Get-Date</${B}${B}DSML${B}${B}parameter></${B}${B}DSML${B}${B}invoke>`,
  'bare tags': '<invoke name="pwsh"><parameter name="command">dir</parameter></invoke>',
  'single bar': `<${B}DSML${B}invoke name="pwsh">Get-Date</${B}DSML${B}invoke>`,
  'antml tags': '<antml:invoke name="pwsh"><antml:parameter name="command">dir</antml:parameter></antml:invoke>',
  'the plugin\'s own bracket form': '[tool call: pwsh {"command":"dir"}]'
};

test('a stored leak is not replayed by any of the three flatteners', () => {
  const failures = [];
  for (const [label, markup] of Object.entries(LEAKS)) {
    const history = [user('do the thing'), assistant(`Checking first. ${markup}`), user('and again')];
    for (const [name, render] of [
      ['flattenTranscript', (m) => flattenTranscript(m)],
      ['flattenConversation', (m) => flattenConversation(m)],
      ['appendPrompt', (m) => appendPrompt(m, 'and again')]
    ]) {
      const out = render(history);
      if (MARKUP.test(out)) failures.push(`${name} / ${label} -> ${JSON.stringify(out.slice(0, 140))}`);
    }
  }
  assert.deepEqual(failures, [], `history still teaches the markup:\n${failures.join('\n')}`);
});

test('the words around a stored leak survive', () => {
  // Scrubbing the marker must not scrub the answer: "Checking first." is what the model
  // actually said, and a resumed session that has lost it reads as a blank turn.
  const markup = LEAKS['native DSML'];
  for (const render of [(m) => flattenTranscript(m), (m) => flattenConversation(m), (m) => appendPrompt(m, 'next')]) {
    const out = render([user('go'), assistant(`Checking first. ${markup}`), user('next')]);
    assert.match(out, /Checking first/u, `the prose was lost: ${JSON.stringify(out.slice(0, 140))}`);
  }
});

test('a user writing about the syntax keeps their words', () => {
  // The asymmetry that makes this safe. Deleting a user's quotation would garble the one
  // case where the markup *is* the content.
  const question = user(`what does <invoke name="pwsh"> mean?`);
  const history = [question, assistant('It starts a tool call.'), user('thanks')];
  for (const render of [(m) => flattenTranscript(m), (m) => flattenConversation(m), (m) => appendPrompt(m, 'thanks')]) {
    const out = render(history);
    assert.match(out, /<invoke name="pwsh">/u, `the user's quotation was deleted: ${JSON.stringify(out.slice(0, 160))}`);
  }
});

test('a structured call is still rendered once, with its id', () => {
  // The renderer adds its own `[tool call: … (id …)]` line for structured calls. That line
  // must survive — it is how a replayed transcript says a tool ran at all.
  const history = [
    user('run it'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"ls"}' }] },
    result('c1', 'a.txt'),
    user('thanks')
  ];
  const out = flattenTranscript(history);
  assert.match(out, /\[tool call: pwsh \{"command":"ls"\} \(id c1\)\]/u, `the structured call was lost: ${JSON.stringify(out.slice(0, 200))}`);
  assert.match(out, /a\.txt/u, 'the result was lost');
});

test('clean history is byte-identical to what it was', () => {
  // The scrub is a no-op on a session that never leaked, so nothing about ordinary replays
  // changes: same prompt, same length, same append decision.
  const history = [user('list the files'), assistant('alpha.txt and beta.txt'), user('which is larger')];
  assert.equal(flattenTranscript(history).includes('alpha.txt and beta.txt'), true);
  assert.equal(flattenConversation(history).endsWith('which is larger'), true, 'the instruction is still the tail');
  assert.equal(appendPrompt(history, 'which is larger'), 'list the files\n\nalpha.txt and beta.txt\n\nwhich is larger');
});
