/**
 * Live: the pool under a long run — turns arriving repeatedly, sessions ageing out and returning.
 *
 * Every concurrency check so far lasted seconds. F-045 came out of one of them, which is the reason
 * this probe exists: a defect that needs a race to show up will not show up in the first ten
 * seconds, and a run of minutes exercises paths a burst does not — eviction actually firing, the
 * idle reaper, sessions reused across many turns, and the worker children accumulating or not.
 *
 * What it watches, in order of what would hurt most:
 *
 * - **Leaks** — a child that outlives `close()`. This is F-045's signature.
 * - **Cross-talk** — an answer carrying another session's marker.
 * - **Reuse** — a session id served many times should not open a new child every turn, or the pool
 *   is not doing its job.
 * - **Failure rate** — a run that leaks nothing because most turns failed proves nothing.
 *
 * Usage:
 *   node tools/soak-probe.mjs --provider qoder --model dfmodel --minutes 3 --lanes 3
 *   node tools/soak-probe.mjs --provider workbuddy --model deepseek-v4.1-flash --minutes 3 --lanes 6
 *
 * It reports rather than asserts: it needs credentials and spends quota, so it is not in
 * `npm run check`.
 */
import process from 'node:process';
import { loadBridge } from './probe-loader.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const provider = flag('provider', 'workbuddy');
const model = flag('model', provider === 'qoder' ? 'dfmodel' : 'deepseek-v4.1-flash');
const minutes = Number(flag('minutes', '3'));
const lanes = Number(flag('lanes', '4'));
const pauseMs = Number(flag('pause', '1500'));

/** Session ids rotate through a small set so eviction and reuse are both exercised. */
const SESSION_COUNT = Math.max(2, Math.ceil(lanes / 2));

const { runtime } = await loadBridge();
const report = {
  provider,
  model,
  minutes,
  lanes,
  sessionIds: [],
  turns: { ok: 0, failed: 0 },
  failures: [],
  crossTalk: [],
  peakLiveChildren: 0,
  startedAt: new Date().toISOString(),
  phases: []
};

/** Live worker children: dead ones keep `exitCode === null` but carry a signal. */
function liveChildren() {
  const kids = (process._getActiveHandles?.() ?? []).filter((h) => h?.constructor?.name === 'ChildProcess');
  return kids.filter((kid) => kid.signalCode === null && kid.exitCode === null);
}

let stopped = false;
const seenMarkers = new Map();

try {
  const adapter = await runtime.waitFor(provider);

  const deadline = Date.now() + minutes * 60_000;
  const allAnswers = [];

  async function lane(index) {
    let turn = 0;
    while (!stopped && Date.now() < deadline) {
      const sessionId = report.sessionIds[index % SESSION_COUNT];
      // The marker is what makes attribution possible: a reply must carry its own tag.
      const marker = `M${index}-${turn}-${Math.random().toString(36).slice(2, 7)}`;
      const started = Date.now();
      let text = '';
      try {
        for await (const chunk of adapter.stream({
          provider,
          model,
          sessionId,
          maxTokens: 32,
          messages: [
            { role: 'user', content: [{ type: 'text', text: `Add 2 and 3, then reply exactly: ${marker}=5` }] }
          ]
        })) {
          if (chunk.type === 'text-delta') text += chunk.text ?? '';
        }
        report.turns.ok += 1;
        allAnswers.push({ lane: index, sessionId, marker, text, ms: Date.now() - started });
        seenMarkers.set(marker, { lane: index, sessionId });
      } catch (error) {
        report.turns.failed += 1;
        report.failures.push({
          lane: index,
          sessionId,
          message: String(error?.message ?? error).slice(0, 160),
          code: error?.failure?.code ?? error?.bridgeCode ?? null
        });
      }
      const live = liveChildren().length;
      if (live > report.peakLiveChildren) report.peakLiveChildren = live;
      turn += 1;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  report.sessionIds = Array.from({ length: SESSION_COUNT }, (_, i) => `soak-${provider}-${i}`);

  // Run in waves so the report can show whether the pool degrades over time rather than only
  // whether it survived.
  const wave = Math.ceil(minutes / 3);
  for (let w = 0; w < 3 && Date.now() < deadline; w += 1) {
    const laneStats = await Promise.all(
      Array.from({ length: lanes }, (_, i) =>
        lane(i).then(() => ({ lane: i }))
      )
    );
    void laneStats;
    report.phases.push({
      wave: w + 1,
      at: new Date().toISOString(),
      ok: report.turns.ok,
      failed: report.turns.failed,
      liveChildren: liveChildren().length
    });
    if (wave === 0) break;
  }

  // Attribution over everything the run produced.
  for (const answer of allAnswers) {
    for (const other of allAnswers) {
      if (other === answer) continue;
      if (other.lane === answer.lane) continue;
      if (answer.text.includes(other.marker)) {
        report.crossTalk.push({ in: answer.marker, leaked: other.marker, fromLane: other.lane });
      }
    }
  }
  report.unattributed = allAnswers.filter((a) => !a.text.includes(a.marker)).length;
  // Keep the text of unattributed answers. "Did not echo the marker" has two very different
  // causes — a model that reformatted, and an answer that belongs to another turn — and only the
  // text distinguishes them. Without this the count alone is unreadable.
  report.unattributedSamples = allAnswers
    .filter((a) => !a.text.includes(a.marker))
    .slice(0, 5)
    .map((a) => ({ marker: a.marker, lane: a.lane, ms: a.ms, text: a.text.slice(0, 120) }));
  report.answerSample = allAnswers.slice(0, 3).map((a) => ({ marker: a.marker, text: a.text.slice(0, 60), ms: a.ms }));

  stopped = true;
  report.liveBeforeClose = liveChildren().length;
  const closeStart = Date.now();
  await runtime.close();
  report.closeMs = Date.now() - closeStart;
  report.liveAfterClose = liveChildren().length;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  report.liveAfterGrace = liveChildren().length;
  report.closedCleanly = report.liveAfterGrace === 0;
} catch (error) {
  report.fatal = String(error?.message ?? error);
} finally {
  stopped = true;
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}

const lingering = setTimeout(() => {
  process.stderr.write('soak-probe: something is still holding the event loop open\n');
  process.exit(3);
}, 5_000);
lingering.unref?.();
