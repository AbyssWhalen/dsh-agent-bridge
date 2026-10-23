/**
 * Live: can one session id carry two turns at once *inside one host process*?
 *
 * H-018 asked whether the desktop app and a headless run could contend for one `sessionId`. The
 * answer turned out to be no, and the reason is structural rather than lucky: the host's JSONL
 * persistence holds a **cross-process write-ownership lock** per session (a named kernel semaphore
 * on Windows, `flock` on POSIX), taken for the life of the write handle and mapped to
 * `SessionAlreadyOwnedError` on contention. Measured directly:
 *
 *     $ dsh headless --session-id S "..."   # first process
 *     $ dsh headless --session-id S "..."   # second, concurrently
 *     {"type":"error","message":"session \"S\" is already owned by an active write handle"}
 *
 * So the second process never reaches the adapter. What the lock does **not** cover is a second
 * turn from inside the owning process itself, and that is the only contention the plugin's `busy`
 * branch can still see. This probe measures that case through the real wiring.
 *
 * Reason it matters: if same-process contention is impossible too, the `busy` branch in
 * `lib/adapter.js#claim` is dead code and its comment ("the desktop app and DSH sharing one agent
 * worker") describes a situation the host prevents. If it is possible, the overflow path is
 * load-bearing and must stay.
 *
 * Usage:
 *   node tools/same-session-probe.mjs --provider workbuddy --model deepseek-v4.1-flash
 *   node tools/same-session-probe.mjs --provider qoder --model dfmodel
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
const sessionId = flag('session', `probe-same-${Date.now()}`);

const { runtime } = await loadBridge();
const report = { provider, model, sessionId, turns: [], note: null };

try {
  const adapter = await runtime.waitFor(provider);

  /**
   * One turn. The prompt asks the model to echo a marker, so an answer can be attributed to the
   * turn that produced it — a shared session would show one turn's marker in the other's history.
   */
  const runTurn = async (label) => {
    const started = Date.now();
    let text = '';
    let failure = null;
    try {
      for await (const chunk of adapter.stream({
        provider,
        model,
        sessionId,
        maxTokens: 64,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Reply with exactly: ${label}` }] }]
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? '';
      }
    } catch (error) {
      failure = { message: String(error?.message ?? error), code: error?.failure?.code ?? error?.bridgeCode ?? null };
    }
    return { label, ms: Date.now() - started, text: text.slice(0, 160), failure };
  };

  // Both turns are started in the same tick, on one session id, inside this one process. This is
  // the only shape the plugin's busy branch can still see.
  const startedSameTick = Date.now();
  const both = await Promise.all([runTurn('TURN-ALPHA'), runTurn('TURN-BETA')]);
  report.turns = both;
  report.sameTickOverlap = Math.abs((both[0]?.ms ?? 0) - (both[1]?.ms ?? 0)) < 50;
  report.wallMs = Date.now() - startedSameTick;

  // Attribution: neither answer should carry the other turn's marker.
  const alpha = both.find((t) => t.label === 'TURN-ALPHA');
  const beta = both.find((t) => t.label === 'TURN-BETA');
  report.crossTalk = [];
  if (alpha?.text.includes('TURN-BETA')) report.crossTalk.push('ALPHA answer carries BETA marker');
  if (beta?.text.includes('TURN-ALPHA')) report.crossTalk.push('BETA answer carries ALPHA marker');

  // A second, sequential turn on the same id: this must be served, and it is the case that proves
  // the session survives the contention.
  const after = await runTurn('TURN-GAMMA');
  report.afterContention = after;

  await runtime.close();
  report.closedCleanly = true;
} catch (error) {
  report.note = `probe failed: ${String(error?.message ?? error)}`;
} finally {
  console.log(JSON.stringify(report, null, 2));
}

const lingering = setTimeout(() => {
  process.stderr.write('same-session-probe: something is still holding the event loop open\n');
  process.exit(3);
}, 5_000);
lingering.unref?.();
