/**
 * Live: what happens to the pool when a Qoder session reaps itself for being idle?
 *
 * `drivers/qoder/session.js` arms a `IDLE_TEARDOWN_MS` (5 min) timer on every sign of life and
 * calls its own `close()` when it fires. The pool is never told. `Pool.peek` still reports the
 * entry as `idle` and `Pool.take` still hands it out — measured offline:
 *
 *     peek after self-close: idle
 *     take result state: taken handle.closed: true
 *
 * So the next turn after five quiet minutes is served by a session that has already shut its
 * worker child down. Whether that shows up as a clean rebuild, a failed turn, or a hang is what
 * this probe answers — and the answer decides whether the adapter needs to revalidate on `take`.
 *
 * The wait is real: 5 minutes idle plus the turn on either side, so this costs quota and wall
 * clock. That is the point of H-022 — the path cannot be reached any other way, because the
 * threshold is a module constant rather than an option.
 *
 * Usage:
 *   node tools/idle-reap-probe.mjs                      # default: 5m40s idle
 *   node tools/idle-reap-probe.mjs --idle-seconds 340
 */
import process from 'node:process';
import { loadBridge } from './probe-loader.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const idleSeconds = Number(flag('idle-seconds', '340'));
const provider = 'qoder';
const model = 'dfmodel';

const { runtime } = await loadBridge();
const report = {
  provider,
  model,
  idleSeconds,
  steps: []
};

function liveChildren() {
  const kids = (process._getActiveHandles?.() ?? []).filter((h) => h?.constructor?.name === 'ChildProcess');
  return kids.filter((kid) => kid.signalCode === null && kid.exitCode === null).length;
}

function note(step, extra = {}) {
  report.steps.push({ step, at: new Date().toISOString(), liveChildren: liveChildren(), ...extra });
}

try {
  const adapter = await runtime.waitFor(provider);
  const sessionId = `idle-${Date.now()}`;
  report.sessionId = sessionId;

  /** One turn; returns what came out rather than throwing, because a failure is a result here. */
  async function turn(label) {
    const started = Date.now();
    let text = '';
    let failure = null;
    try {
      for await (const chunk of adapter.stream({
        provider,
        model,
        sessionId,
        maxTokens: 24,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Reply with exactly: ${label}` }] }]
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? '';
      }
    } catch (error) {
      failure = {
        message: String(error?.message ?? error).slice(0, 200),
        code: error?.failure?.code ?? error?.bridgeCode ?? null
      };
    }
    return { label, ms: Date.now() - started, text: text.slice(0, 80), failure };
  }

  report.firstTurn = await turn('BEFORE-IDLE');
  note('after first turn');

  // Idle past the reaper. Nothing touches the session in between: no turn, no catalog read.
  const idleStart = Date.now();
  report.idleMs = idleSeconds * 1000;
  await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000));
  report.idleElapsedMs = Date.now() - idleStart;
  note('after idle wait', { reaperShouldHaveFired: true });

  // The question: is this turn served by a rebuilt worker, or does it fail?
  report.afterIdleTurn = await turn('AFTER-IDLE');
  note('after post-idle turn');

  // A third turn tells apart "rebuilt once" from "broken from here on".
  report.thirdTurn = await turn('AFTER-IDLE-2');
  note('after third turn');

  report.verdict = report.afterIdleTurn.failure === null ? 'served' : 'failed';
  report.rebuilt = report.afterIdleTurn.failure === null && report.thirdTurn.failure === null;

  report.liveBeforeClose = liveChildren();
  const closeStart = Date.now();
  await runtime.close();
  report.closeMs = Date.now() - closeStart;
  report.liveAfterClose = liveChildren();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  report.liveAfterGrace = liveChildren();
} catch (error) {
  report.fatal = String(error?.message ?? error);
} finally {
  console.log(JSON.stringify(report, null, 2));
}

const lingering = setTimeout(() => {
  process.stderr.write('idle-reap-probe: something is still holding the event loop open\n');
  process.exit(3);
}, 5_000);
lingering.unref?.();
