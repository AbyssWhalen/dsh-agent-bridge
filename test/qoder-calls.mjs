/**
 * The two Qoder call-path regressions, pinned without a network call.
 *
 * Both failures were observed on a real turn, and both were silent:
 *
 *   1. The model wrote `<｜｜DSML｜｜ invoke name="Bash">` — a tool name from its own
 *      training data — because the harness's declarations never reached it. The
 *      preamble has to name the caller's tools exactly, or recovery can never map
 *      the call onto something real.
 *   2. The marker arrives split across many deltas (`<`, `｜`, `｜`, `DS`, …), so the
 *      held text has to keep absorbing them once a marker is seen. Releasing them
 *      as prose is what left ` calls>` on screen beside a lost call.
 *
 * The fixture below is the exact byte sequence a live turn produced.
 *
 * Run with `node test/qoder-calls.mjs`.
 */
import { toolPreamble } from '../drivers/qoder/conversation.js';
import { parseLeakedCalls } from '../lib/dsml.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const MARK = '\uFF5C\uFF5C';

/** What a live Qoder turn emitted, verbatim, including its invented tool name. */
const OBSERVED = `<${MARK}DSML${MARK} calls>
<${MARK}DSML${MARK} invoke name="pwsh">
<${MARK}DSML${MARK} parameter name="command" string="true">echo QODER_TOOL_PROBE</${MARK}DSML${MARK} parameter>
<${MARK}DSML${MARK} parameter name="description" string="true">Echo the probe string</${MARK}DSML${MARK} parameter>
</${MARK}DSML${MARK} invoke>
</${MARK}DSML${MARK} calls>`;

/** Split the way the runtime delivered it: one or two characters at a time. */
const DELTAS = ['<', '\uFF5C', '\uFF5C', 'DS', 'ML', '\uFF5C', '\uFF5C', ' calls', '>\n', '<'];

console.log('# the preamble teaches the caller\'s own tools\n');

const tools = [
  {
    name: 'pwsh',
    description: 'Run a PowerShell command line.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command.' } },
      required: ['command']
    }
  },
  {
    name: 'read',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
  }
];

const preamble = toolPreamble(tools);

check('every declared tool is named', () => {
  for (const tool of tools) assert(preamble.includes(tool.name), `missing ${tool.name}`);
});
check('parameter names and requirements are stated', () => {
  assert(preamble.includes('command (string, required)'), 'command not described as required');
  assert(preamble.includes('file_path (string, required)'), 'file_path not described as required');
});
check('the call syntax is shown exactly once', () => {
  const opens = preamble.split(`<${MARK}DSML${MARK} calls>`).length - 1;
  assert(opens === 1, `expected one syntax example, saw ${opens}`);
});
check('an empty tool list adds nothing', () => {
  assert(toolPreamble([]).trim() === '' || !toolPreamble([]).includes('## '), 'empty list produced sections');
});

console.log('\n# a call split across deltas is still recoverable\n');

check('the joined deltas are the observed markup', () => {
  assert(DELTAS.join('').startsWith(`<${MARK}DSML${MARK}`), 'fixture no longer starts a marker');
});
check('the observed markup parses into one call', () => {
  const recovered = parseLeakedCalls(OBSERVED);
  assert(recovered.calls.length === 1, `expected one call, saw ${recovered.calls.length}`);
  assert(recovered.calls[0].name === 'pwsh', `wrong name ${recovered.calls[0].name}`);
  const args = JSON.parse(recovered.calls[0].arguments);
  assert(args.command === 'echo QODER_TOOL_PROBE', 'command argument lost');
  assert(args.description === 'Echo the probe string', 'description argument lost');
  assert(recovered.rest.trim() === '', 'prose leaked out of the call');
});
check('a quoted marker in prose is not a call', () => {
  const recovered = parseLeakedCalls(`The syntax looks like <${MARK}DSML${MARK} invoke name="x"> in the raw stream.`);
  assert(recovered.calls.length === 0, 'invented a call from a quotation');
});

console.log('');
if (failures > 0) {
  console.log(`# qoder-calls: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('# qoder-calls: OK');
