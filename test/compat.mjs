/**
 * The compatibility claim, checked as a claim.
 *
 * ## Why this file exists
 *
 * DSH decides whether to load a plugin by reading that plugin's
 * `peerDependencies` and comparing every `@deepseek-ai/dsh…` entry against the
 * *running* runtime version (`evaluatePluginCompatibility` in
 * `@deepseek-ai/dsh-app-boot`). A bundle that fails is **skipped**, not repaired:
 *
 *   dsh: skipping profile bundle "dsh-agent-bridge": Plugin dsh-agent-bridge@1.0.0
 *   is incompatible with dsh 0.2.1: peerDependencies {"@deepseek-ai/dsh-llm":"0.2.0-rc.2"}.
 *
 * So the spelling of that range is not bookkeeping — it decides whether a routine
 * DSH update leaves this plugin working. An exact pin (`"0.2.0-rc.2"`) means every
 * DSH patch release silently uninstalls the plugin from the user's session, which
 * reads exactly like "the update broke my plugins".
 *
 * The range therefore has to do three things at once, and this test pins all three:
 *
 *   1. accept the version it was actually verified against;
 *   2. accept the rest of that minor line, including later prereleases, so an
 *      `-rc.3` or a `0.2.1` does not turn into a silent skip;
 *   3. reject the next minor, because that is where an `LlmAdapter` contract change
 *      would land — and a refused load is honest, while a load that half-works is not.
 *
 * `@deepseek-ai/cordis` is deliberately *not* under this rule: DSH only evaluates
 * peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`, so a cordis peer is
 * documentation rather than a gate.
 *
 * Run with `node test/compat.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

/** Peers DSH actually evaluates: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`. */
function gatedPeers() {
  return Object.entries(manifest.peerDependencies ?? {}).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
  );
}

/** Whether `version` would be accepted by the running runtime. */
function accepted(version) {
  return gatedPeers().every(([, range]) =>
    semver.satisfies(version, range.trim() === '' ? '0.0.0' : range, { includePrerelease: true })
  );
}

check('the manifest declares at least one peer DSH can gate on', () => {
  assert.ok(gatedPeers().length > 0, 'no @deepseek-ai/dsh* peer means DSH never checks this plugin');
});

check('no gated peer is an exact version', () => {
  for (const [name, range] of gatedPeers()) {
    assert.notEqual(semver.valid(range), range, `${name} is pinned to ${range}; a DSH patch release would skip this plugin`);
  }
});

check('the range accepts every version this build was verified against', () => {
  const verified = manifest.dsh?.compat?.verified;
  assert.ok(Array.isArray(verified) && verified.length > 0, 'dsh.compat.verified must list what was tested');
  for (const version of verified) {
    assert.equal(semver.valid(version), version, `${version} is not an exact version`);
    assert.ok(accepted(version), `${version} does not satisfy the declared peers`);
  }
});

check('the range survives a routine DSH update inside the same minor line', () => {
  const verified = manifest.dsh?.compat?.verified?.[0];
  const parsed = semver.parse(verified);
  assert.ok(parsed !== null, `cannot parse ${verified}`);
  for (const candidate of [
    semver.inc(verified, 'prerelease'),                    // 0.2.0-rc.3
    `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`, // 0.2.1
    `${parsed.major}.${parsed.minor + 1}.0`                // 0.3.0 — the line below rejects this
  ].slice(0, 2)) {
    assert.ok(accepted(candidate), `${candidate} would be skipped after a DSH update`);
  }
});

check('the range refuses the next minor, so a contract change is visible', () => {
  const parsed = semver.parse(manifest.dsh.compat.verified[0]);
  const next = `${parsed.major}.${parsed.minor + 1}.0`;
  assert.equal(accepted(next), false, `${next} is accepted without having been verified`);
});

check('the declared runtime range and the gated peers agree', () => {
  const declared = manifest.dsh?.compat?.runtime;
  assert.equal(typeof declared, 'string', 'dsh.compat.runtime must exist');
  const [name, range] = gatedPeers()[0];
  assert.equal(declared, range, `dsh.compat.runtime (${declared}) disagrees with ${name} (${range})`);
});

check('cordis is declared but is not an exact version either', () => {
  const range = manifest.peerDependencies?.['@deepseek-ai/cordis'];
  assert.equal(typeof range, 'string', 'cordis peer is missing');
  assert.notEqual(semver.valid(range), range, `cordis is pinned to ${range}`);
});

check('what the README tells a reader matches what the manifest declares', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const version of manifest.dsh.compat.verified) {
      assert.ok(text.includes(version), `${file} never states the verified DSH version ${version}`);
    }
    assert.ok(
      text.includes(manifest.dsh.compat.runtime),
      `${file} never states the runtime range ${manifest.dsh.compat.runtime}`
    );
  }
});

check('the installed dsh-llm in this checkout is the one verified', () => {
  // The dev dependency is what the offline suite runs against; if it drifted, the
  // tests would be proving a contract the user does not have.
  const installed = JSON.parse(
    readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), 'utf8')
  );
  assert.equal(installed.version, manifest.dsh.compat.checked['@deepseek-ai/dsh-llm']);
});

if (failures > 0) {
  console.log(`\n# ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n# compat: OK');
