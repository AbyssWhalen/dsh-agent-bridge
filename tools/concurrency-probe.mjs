/**
 * Live: several sessions at once through the real wiring.
 *
 * The claim path is covered offline against a stub. This file asks the question a stub cannot:
 * with a real driver, a real worker child, and real network latency, do concurrent turns stay
 * separable, and is everything cleaned up afterwards?
 *
 * It is a probe, not a test — it needs credentials and quota, so it is not in `npm run check`.
 *
 * Usage:
 *   node tools/concurrency-probe.mjs --provider qoder --model dfmodel --sessions 3 --turns 2
 *   node tools/concurrency-probe.mjs --provider workbuddy --model deepseek-v4.1-flash --sessions 5
 *
 * Each session asks a different question that only its own turn could produce (a token it was
 * given), so a reply landing in the wrong session is visible in the output rather than inferred
 * from timing. The probe reports: per-session answers, whether any answer carries another
 * session's token, the peak overlap, and how many driver sessions were still open at the end.
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
const sessions = Number(flag('sessions', '3'));
const turns = Number(flag('turns', '1'));
const maxTokens = Number(flag('maxTokens', '64'));

/**
 * A token no model would guess, so an answer can be attributed to the turn that produced it.
 *
 * The question around it is deliberately arithmetic-plus-echo: asking a model to "repeat this
 * token" makes some of them refuse ("I can't repeat arbitrary tokens"), and a refusal is
 * indistinguishable from a lost answer in this report. Asking it to add two numbers and include
 * a tag produces the same attribution evidence without tripping that refusal.
 */
function token() {
  return `tl-${Math.random().toString(36).slice(2, 10)}`;
}

/** A prompt whose reply must carry the tag, so a missing tag means the turn went astray. */
function question(tag) {
  return `Add 2 and 3. Then reply in exactly this form, nothing else: ${tag}=5`;
}

const { runtime } = await loadBridge();
const report = {
  provider,
  model,
  sessions,
  turns,
  answers: [],
  crossTalk: [],
  overlapPeak: 0,
  errors: []
};

try {
  const adapter = await runtime.waitFor(provider);

  // Each session runs its turns back-to-back; all sessions run at once. Any overlap between two
  // sessions' spans is real concurrency, not scheduling luck.
  const spans = [];
  const runSession = async (index) => {
    const sessionId = `probe-${provider}-${index}`;
    for (let turn = 0; turn < turns; turn += 1) {
      const wanted = token();
      const started = Date.now();
      let text = '';
      try {
        for await (const chunk of adapter.stream({
          provider,
          model,
          sessionId,
          maxTokens,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: question(wanted) }]
            }
          ]
        })) {
          if (chunk.type === 'text-delta') text += chunk.text ?? '';
        }
        report.answers.push({ sessionId, turn, wanted, text: text.slice(0, 120), ms: Date.now() - started });
      } catch (error) {
        report.errors.push({
          sessionId,
          turn,
          message: String(error?.message ?? error),
          code: error?.failure?.code ?? error?.bridgeCode ?? null
        });
      }
      spans.push({ sessionId, started, ended: Date.now() });
    }
  };

  const wallStart = Date.now();
  await Promise.all(Array.from({ length: sessions }, (_, index) => runSession(index)));
  report.wallMs = Date.now() - wallStart;

  // Peak overlap: how many session spans were live at the same instant.
  const edges = [];
  for (const span of spans) {
    edges.push({ at: span.started, delta: 1 });
    edges.push({ at: span.ended, delta: -1 });
  }
  edges.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let live = 0;
  for (const edge of edges) {
    live += edge.delta;
    if (live > report.overlapPeak) report.overlapPeak = live;
  }

  // Cross-talk: an answer containing a token from a *different* turn.
  const bySession = new Map();
  for (const answer of report.answers) {
    bySession.set(answer.sessionId, [...(bySession.get(answer.sessionId) ?? []), answer]);
  }
  for (const answer of report.answers) {
    for (const other of report.answers) {
      if (other === answer) continue;
      if (other.sessionId === answer.sessionId) continue;
      if (answer.text.includes(other.wanted)) {
        report.crossTalk.push({ in: answer.sessionId, turn: answer.turn, leaked: other.wanted, from: other.sessionId });
      }
    }
  }

  // Attribution: did each answer at least carry its own token?
  for (const answer of report.answers) {
    if (!answer.text.includes(answer.wanted)) {
      report.errors.push({
        sessionId: answer.sessionId,
        turn: answer.turn,
        message: `answer did not carry its own token; got ${JSON.stringify(answer.text)}`,
        code: 'UNATTRIBUTED'
      });
    }
  }

  // Teardown: after `close()` the pool must hold nothing. The probe cannot see the pool directly,
  // so it reports what it can: whether closing threw, and whether the process can exit.
  try {
    await runtime.close();
    report.closedCleanly = true;
  } catch (error) {
    report.closedCleanly = false;
    report.errors.push({ sessionId: '*', turn: -1, message: `close failed: ${String(error?.message ?? error)}`, code: 'CLOSE' });
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
}

// A leaked worker child keeps the process alive. This is the only way the probe can see the leak
// from the outside, and it is why the probe reports rather than asserting.
const lingering = setTimeout(() => {
  process.stderr.write('concurrency-probe: something is still holding the event loop open\n');
  process.exit(3);
}, 5_000);
lingering.unref?.();
