/**
 * A call written in the `argument key=… <|open|> … <|sep|> …` dialect must still be recovered.
 *
 * Measured on a real turn (Qoder, `kmodel_latest`, 2026-10-23). The model wrote its call as text,
 * in a shape this project had never seen:
 *
 *     <｜｜DSML｜｜ calls>
 *     <｜｜DSML｜｜ invoke name="pwsh">
 *     <｜｜DSML｜｜DSML｜parameter name="command">Get-ChildItem -Force | Select-Object -ExpandProperty Name<|open|>argument key="description" type="string"<|sep|>List files in current directory
 *
 * Two things go wrong with it, and they compound:
 *
 * 1. `parseLeakedCalls` recovers **no calls**. The opening markers are the fullwidth single bar
 *    that `BARS` already accepts, but the arguments are separated by Kimi's reserved tokens
 *    (`<|open|>`, `<|sep|>`) and named with `key=` rather than `name=`, so no pattern matches.
 * 2. Having recovered nothing, the driver's fallback is to show the block **as written**. The
 *    user gets a wall of markers where an answer should be, and nothing ran — the transcript of
 *    that run begins with the marker run and contains no file listing.
 *
 * So the fix has two halves and both are needed: recognise the dialect, and — if a future model
 * invents yet another one — never hand the raw markers to the user.
 */
import assert from 'node:assert/strict';
import { hasLeak, parseLeakedCalls, stripLeak } from '../lib/dsml.js';

let passed = 0;
let failed = 0;

async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split('\n')[0]}`);
  }
}

/** The block exactly as the live turn wrote it. */
const LIVE_BLOCK = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="pwsh">',
  '<｜｜DSML｜｜ parameter name="command">Get-ChildItem -Force | Select-Object -ExpandProperty Name<|open|>argument key="description" type="string"<|sep|>List files in current directory'
].join('\n');

// ── 1. The dialect is recognised ─────────────────────────────────────────────────
await check('the reserved-token dialect is seen as a leak, not as prose', () => {
  assert.equal(hasLeak(LIVE_BLOCK), true, 'the block was not recognised as call syntax at all');
});

await check('the reserved-token dialect yields one call', () => {
  const { calls } = parseLeakedCalls(LIVE_BLOCK);
  assert.equal(calls.length, 1, `recovered ${calls.length} calls`);
});

await check('the tool name survives', () => {
  const { calls } = parseLeakedCalls(LIVE_BLOCK);
  assert.equal(calls[0]?.name, 'pwsh', `name was ${JSON.stringify(calls[0]?.name)}`);
});

await check('the first argument keeps its value and nothing else', () => {
  const { calls } = parseLeakedCalls(LIVE_BLOCK);
  const args = JSON.parse(calls[0]?.arguments ?? '{}');
  assert.equal(args.command, 'Get-ChildItem -Force | Select-Object -ExpandProperty Name');
});

await check('the key= argument is recovered under its own name', () => {
  const { calls } = parseLeakedCalls(LIVE_BLOCK);
  const args = JSON.parse(calls[0]?.arguments ?? '{}');
  assert.equal(args.description, 'List files in current directory');
});

await check('no marker text survives into the recovered remainder', () => {
  const { calls } = parseLeakedCalls(LIVE_BLOCK);
  const args = JSON.stringify(calls.map((call) => call.arguments));
  assert.equal(/<\|open\|>|<\|sep\|>/u.test(args), false, `markers reached the arguments: ${args}`);
});

// ── 2. The same, with a second argument ──────────────────────────────────────────
await check('two key= arguments both survive', () => {
  const block = [
    '<｜｜DSML｜｜ invoke name="pwsh">',
    '<｜｜DSML｜｜ parameter name="command">Get-ChildItem<|open|>argument key="description" type="string"<|sep|>List files<|open|>argument key="timeout" type="number"<|sep|>5000'
  ].join('\n');
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1, `recovered ${calls.length} calls`);
  const args = JSON.parse(calls[0]?.arguments ?? '{}');
  assert.equal(args.command, 'Get-ChildItem');
  assert.equal(args.description, 'List files');
  assert.equal(args.timeout, 5000, 'a numeric argument arrived as a string');
});

// ── 3. The canonical dialect must keep working ───────────────────────────────────
await check('the canonical closing-tag form is unaffected', () => {
  const block = [
    '<｜｜DSML｜｜ invoke name="pwsh">',
    '<｜｜DSML｜｜ parameter name="command">Get-ChildItem</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>'
  ].join('\n');
  const { calls } = parseLeakedCalls(block);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].arguments).command, 'Get-ChildItem');
});

// ── 4. A block that cannot be read must not be shown as markers ──────────────────
await check('stripLeak removes the markers even when no call can be recovered', () => {
  const nonsense = '<｜｜DSML｜｜ invoke name=""><｜｜DSML｜｜ parameter name=""<|open|>argument key=<|sep|>';
  const stripped = stripLeak(nonsense);
  assert.equal(/｜{2,}/u.test(stripped), false, `markers survived: ${JSON.stringify(stripped)}`);
});

console.log(`\ndsml reserved-token dialect: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
