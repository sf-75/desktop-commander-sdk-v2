/**
 * #196: while pytest -v collected its tests, its output ended in "collecting ... "
 * and start_process answered "🔄 Process N is waiting for input (detected:
 * "...")". A prompt was found anywhere in the last line of output, and generic
 * prompts such as "... " (Python's continuation prompt), "> " or "       "
 * (Julia's continuation) are ordinary text inside a longer line.
 *
 * Checks the issue's own output (fixtures/pytest-196.js; only the reporter's path
 * replaced with a neutral one) against the detection,
 * then through start_process; and that real prompts are still detected: a REPL's
 * prompt as the whole last line, the prompts a REPL wrote one after another to
 * stderr (">>> ... "), a named prompt ("done>>> ") or a shell prompt
 * ("user@Mac project % ") at its end, and the prompts real Windows shells print
 * (fixtures/windows-shell-prompts.js: powershell.exe, pwsh, cmd.exe, captured from
 * real sessions; only the working directory in them was replaced with a neutral
 * one). Then interact_with_process in a real shell session returns at its
 * prompt: PowerShell on Windows, bash on macOS and Linux (the pwsh preinstalled
 * on GitHub's Ubuntu runner wraps its prompt in terminal codes).
 *
 * Node 24's continuation prompt, "| " (fixtures/node-repl-prompts.js, captured
 * from node -i on Windows and macOS), is a prompt too, the way #196 counts a
 * generic one: in a last line made of prompts ("> | "). A session left at it
 * wasn't detected as waiting, so interact_with_process waited out its timeout.
 * A markdown table's lines ("| a | b |") are not prompts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeProcessState } from '../dist/utils/process-detection.js';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { PYTEST_COLLECTING, PYTEST_PROGRESS_LINE } from './fixtures/pytest-196.js';
import { WINDOWS_SHELL_PROMPTS } from './fixtures/windows-shell-prompts.js';
import { NODE_24_SESSIONS } from './fixtures/node-repl-prompts.js';
import { runIfMain } from './helpers/run-if-main.js';

// node -i's captured output: its session at the continuation prompt after "function f() {", and the lines of the
// markdown table it printed (each as the last line, before its newline)
const NODE_24_CONTINUATION = NODE_24_SESSIONS.map(([os, banner, exchanges]) =>
  [`node -i (${os}) at its continuation prompt`, banner + exchanges[0][1]]);
const TABLE_LINES = NODE_24_SESSIONS[0][2][4][1].split('\n').slice(0, 3);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pytest-196.js');
const SPLIT_LINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'split-line-ready-diagnostic.js');
// The shell answers "echo hi" within a second or two; missing its prompt runs to the timeout
const INTERACT_TIMEOUT_MS = 20_000;
const PROMPT_WITHIN_MS = 5_000;

// Output that ends in ordinary text, not a prompt
const NOT_PROMPTS = [
  ['pytest -v while it collects (#196)', PYTEST_COLLECTING],
  ['a pytest progress line before its newline (padding, then "[100%]")', PYTEST_PROGRESS_LINE],
  ...TABLE_LINES.map((line) => [`a markdown table's line before its newline (${line})`, line]),
  // The first piece of a line, before the rest of it arrives (fixtures/split-line.js)
  ['a piece of a line ending in ">"', '<div>'],
  ['a piece of a line ending in "$"', 'costs 5$'],
  ['a piece of a line ending in "#"', 'see issue #'],
];

// Output that ends in a prompt
const PROMPTS = [
  ['python', 'x = 1\n>>> '],
  ['python continuation', 'def f():\n... '],
  ['python, after output without a newline', 'done>>> '],
  // A REPL that writes its prompts to stderr and doesn't echo input leaves them on one line there
  ['python -i prompts on stderr', '>>> >>> ... '],
  ['a shell\'s prompts on stderr', '$ $ '],
  ['node', '1\n> '],
  ...NODE_24_CONTINUATION,
  ['R continuation', '+ '],
  ['shell', '$ '],
  ['bash default', 'bash-5.2$ '],
  ['bash -i prompts on stderr', 'bash-5.2$ bash-5.2$ '],
  ['bash with user@host', 'user@host:~/project$ '],
  ['root shell', 'root@box:/# '],
  ['zsh default on macOS', 'user@Mac project % '],
  ['mysql', 'mysql> '],
  ['julia', 'julia> '],
  ['psql', 'postgres=# '],
  ...WINDOWS_SHELL_PROMPTS,
];

const failures = [];
function check(ok, message) {
  if (!ok) {
    failures.push(message);
    console.log(`❌ ${message}`);
  }
}

function testDetection() {
  console.log('\n--- detection: the issue\'s output is not a prompt ---');
  for (const [name, output] of NOT_PROMPTS) {
    const state = analyzeProcessState(output);
    check(!state.isWaitingForInput,
      `${name}: output ending in ${JSON.stringify(output.slice(-40))} was taken for a prompt (detected: ${JSON.stringify(state.detectedPrompt)})`);
  }
  console.log('\n--- detection: real prompts are still detected ---');
  for (const [name, output] of PROMPTS) {
    check(analyzeProcessState(output).isWaitingForInput, `${name}: the prompt ${JSON.stringify(output.split('\n').pop())} was not detected`);
  }
}

async function testStartProcess() {
  console.log('\n--- start_process: pytest collecting (#196), output-synchronized ---');
  const readyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pytest-ready-'));
  const ready = path.join(readyDir, 'stdout.ready');
  let pid;
  try {
    const result = await startProcess({ command: `node "${FIXTURE}" "${ready}"`, timeout_ms: 45000 });
    pid = result.structuredContent?.pid;
    const deadline = Date.now() + 40000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    check(fs.existsSync(ready), 'pytest fixture never confirmed stdout write; pid=' + pid + '; start=' + result.content?.[0]?.text?.slice(-160));
    let text = result.content[0].text;
    let status = result.structuredContent?.status;
    while (!text.includes('collecting ... ') && pid > 0 && Date.now() < deadline) {
      const more = await readProcessOutput({ pid, timeout_ms: 1000, offset: -30 });
      text += '\n' + (more.content?.[0]?.text ?? '');
      status = more.structuredContent?.status ?? status;
    }
    check(text.includes('collecting ... '), `pytest collecting output absent: ${text.slice(-200)}`);
    check(!text.includes('waiting for input'), `pytest was misidentified as prompt: ${text.slice(-160)}`);
    check(status === 'running', `pytest status: ${status}`);
  } finally {
    if (pid > 0) await forceTerminate({ pid });
    fs.rmSync(readyDir, { recursive: true, force: true });
  }
}

/**
 * A line that arrives in two pieces, the first ending like a prompt ("<div>",
 * "costs 5$", "see issue #"), is not a prompt: start_process must not end its
 * wait on that piece (it did, testing each output chunk on its own).
 */
async function testStartProcessOnAPieceOfALine() {
  console.log('\n--- start_process: ready-synchronized split line ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-split-ready-'));
  try {
    for (const piece of ['markup', 'dollar', 'hash']) {
      const ready = path.join(dir, `${piece}.ready`);
      const trigger = path.join(dir, `${piece}.trigger`);
      let gate;
      let pid;
      try {
        const readySignal = new Promise((resolve, reject) => {
          const started = Date.now();
          gate = setInterval(() => {
            if (fs.existsSync(ready)) {
              clearInterval(gate);
              setTimeout(() => { fs.writeFileSync(trigger, ''); resolve(); }, 150);
            } else if (Date.now() - started > 35000) {
              clearInterval(gate);
              reject(new Error(`fixture readiness timeout: ${piece}`));
            }
          }, 25);
        });
        const started = startProcess({ command: `node "${SPLIT_LINE}" "${ready}" "${trigger}" ${piece}`, timeout_ms: 39000 });
        let result;
        try {
          [result] = await Promise.all([started, readySignal]);
        } catch (error) {
          // Drain the already-started operation before deleting the fixture directory.
          const settled = await Promise.allSettled([started]);
          pid = settled[0].status === 'fulfilled' ? settled[0].value.structuredContent?.pid : undefined;
          check(false, 'split-line ' + piece + ': ' + String(error));
          continue;
        }
        pid = result.structuredContent?.pid;
        const text = result.content[0].text;
        check(text.includes('and the rest of the line') && result.structuredContent?.status === 'running',
          `split-line ${piece} must be complete while process is running: ${JSON.stringify(text.slice(0, 150))}`);
      } finally {
        clearInterval(gate);
        if (pid > 0) await forceTerminate({ pid });
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function testInteractWithShell() {
  const [name, command] = process.platform === 'win32' ? ['PowerShell', 'powershell -NoLogo'] : ['bash', 'bash --norc --noprofile -i'];
  console.log(`\n--- interact_with_process: a real ${name} session ---`);
  const started = await startProcess({ command, timeout_ms: 10_000 });
  const pid = started.structuredContent?.pid;
  try {
    // Wait for the real initial shell prompt before sending the first command.
    let readyStatus = started.structuredContent?.status;
    let readyText = started.content[0].text;
    const shellDeadline = Date.now() + 15000;
    while (readyStatus !== 'waiting_for_input' && pid > 0 && Date.now() < shellDeadline) {
      const next = await readProcessOutput({ pid, timeout_ms: 1000, offset: -30 });
      readyText += '\n' + (next.content?.[0]?.text ?? '');
      readyStatus = next.structuredContent?.status ?? (next.content?.[0]?.text?.includes('is waiting for input (detected:') ? 'waiting_for_input' : readyStatus);
      if (readyStatus !== 'waiting_for_input') await new Promise(resolve => setTimeout(resolve, 100));
    }
    check(readyStatus === 'waiting_for_input',
      'shell prompt not detected after readiness wait: ' + readyStatus + ': ' + readyText.slice(-160));
    const startedAt = Date.now();
    const answer = await interactWithProcess({ pid, input: 'echo hi', timeout_ms: INTERACT_TIMEOUT_MS });
    const ms = Date.now() - startedAt;
    const text = answer.content[0].text;
    check(ms < PROMPT_WITHIN_MS,
      `interact_with_process should return at ${name}'s prompt, took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms): ${text.slice(-160)}`);
    check(answer.structuredContent?.status === 'waiting_for_input', `status should be waiting_for_input, got ${answer.structuredContent?.status}`);
    check(text.includes('hi'), `${name}'s answer should be returned, got: ${text.slice(-160)}`);
  } finally {
    if (pid > 0) {
      // "exit" ends the shell session; force_terminate then ends whatever is left
      await interactWithProcess({ pid, input: 'exit', wait_for_prompt: false });
      await forceTerminate({ pid });
    }
  }
}

async function testInteractAtNodeContinuation() {
  console.log('\n--- interact_with_process: node -i at its continuation prompt ---');
  const started = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const pid = started.structuredContent?.pid;
  try {
    // [input, what the answer shows]: a statement typed a line at a time, then its result
    for (const [input, output] of [['function f() {', null], ['  return 1;', null], ['}', 'undefined'], ['f()', '1']]) {
      const startedAt = Date.now();
      const answer = await interactWithProcess({ pid, input, timeout_ms: INTERACT_TIMEOUT_MS });
      const ms = Date.now() - startedAt;
      const text = answer.content[0].text;
      check(ms < PROMPT_WITHIN_MS && answer.structuredContent?.status === 'waiting_for_input',
        `interact_with_process ${JSON.stringify(input)} should return at node's prompt, took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms), status ${answer.structuredContent?.status}: ${JSON.stringify(text)}`);
      check(output === null ? text.includes('📭 (No output produced)') : text.includes(`📤 Output:\n${output}\n`),
        `interact_with_process ${JSON.stringify(input)} should answer ${output === null ? 'with no output' : JSON.stringify(output)}, got: ${JSON.stringify(text)}`);
    }
  } finally {
    if (pid > 0) await forceTerminate({ pid });
  }
}

async function runTests() {
  // Run independent cases without paying the cost of slow OS process cleanup in unrelated cases.
  const cases = new Map([
    ['detection', testDetection],
    ['pytest', testStartProcess],
    ['split-line', testStartProcessOnAPieceOfALine],
    ['node-repl', testInteractAtNodeContinuation],
    ['shell', testInteractWithShell],
  ]);
  const requested = process.argv.slice(2);
  const selected = requested.length ? requested : [...cases.keys()];
  for (const name of selected) {
    if (!cases.has(name)) {
      console.error(`Unknown test case: ${name}; valid cases: ${[...cases.keys()].join(', ')}`);
      return false;
    }
  }
  for (const name of selected) {
    try {
      await cases.get(name)();
    } catch (error) {
      check(false, `${name} threw: ${error?.stack ?? error}`);
    }
  }
  console.log(failures.length === 0
    ? `\n✅ prompt detection tests passed (${selected.join(', ')})`
    : `\n❌ ${failures.length} prompt detection checks failed (${selected.join(', ')})`);
  return failures.length === 0;
}
runIfMain(import.meta.url, runTests);

export default runTests;
