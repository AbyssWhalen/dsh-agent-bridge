/**
 * Guarantee that a live test ends with a verdict line.
 *
 * ## Why this exists
 *
 * Every live test in this suite prints one greppable line — `<Vendor> driver: OK` — so the
 * whole set can be run and checked with a single search. That contract was easy to break by
 * accident: a test whose main body sits in `try { … } finally { … }` with no `catch` does not
 * print a verdict when the vendor fails. It dies with a raw stack trace instead. The same
 * happens to a test whose main body is a bare sequence of top-level `await`s.
 *
 * This was not hypothetical. A driver that talked to a vendor's self-deployed endpoint saw an
 * intermittent `504`, the test retried once, the retry hit the same `504`, and the process
 * exited on an unhandled rejection with a stack pointing into the driver — which reads like a
 * driver crash and is not one. A test that fails by crashing is worse than useless: it hides
 * the verdict the suite is built around and misattributes the cause.
 *
 * So the verdict is installed as a process-level guarantee rather than written at the end of
 * a happy path. Whatever route the failure takes — a thrown error, a rejected promise nobody
 * awaited, an exception from a callback — exactly one verdict line is printed, and it is
 * printed before the process exits.
 *
 * @module dsh-agent-bridge/test/verdict
 */

/**
 * Install the guarantee for one test.
 *
 * @param {string} name Vendor label used in the verdict line, e.g. `Qoder`.
 * @returns {{pass: () => void, fail: (detail: string) => void}}
 */
export function verdict(name) {
  let reported = false;

  const report = (ok, detail) => {
    // Exactly one line: a late second failure must not append a contradictory verdict
    // after a passing one, and a failure reported twice reads like two problems.
    if (reported) return;
    reported = true;
    if (ok) {
      console.log(`\n${name} driver: OK`);
      return;
    }
    console.log(`\n${name} driver: FAIL — ${detail}`);
    process.exitCode = 1;
  };

  // The truncation is deliberate: these lines are meant to be read in a terminal and
  // grepped, so the useful part is the first sentence, not a full stack.
  const describe = (value) => {
    const text = value instanceof Error ? `${value.message}` : String(value);
    return text.replace(/\s+/g, ' ').slice(0, 300);
  };

  process.on('unhandledRejection', (reason) => {
    report(false, `unhandled rejection: ${describe(reason)}`);
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    report(false, `uncaught exception: ${describe(error)}`);
    process.exit(1);
  });

  return {
    pass: () => report(true),
    fail: (detail) => {
      report(false, detail);
      process.exit(1);
    }
  };
}
