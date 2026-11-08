import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  createProcessToolContext,
  disposeProcessToolContext,
  forceTerminate,
  interactWithProcess,
  startProcess,
} from '../dist/tools/improved-process-tools.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

function isAlive(pid) {
  if (process.platform === 'win32') {
    const output = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return output.includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExecution(context, virtualPid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const processes = context.activeNodeExecutions.get(virtualPid);
    const child = processes?.values().next().value;
    if (child?.pid) return child;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('node:local child process was not registered');
}

async function startLongRunningNodeSession(context) {
  const started = await startProcess({ command: 'node:local', timeout_ms: 30000 }, undefined, context);
  const startText = started.content?.map((item) => item.text ?? '').join('\n') ?? '';
  const virtualPid = Number(/PID (-\d+)/.exec(startText)?.[1]);
  assert(Number.isInteger(virtualPid) && virtualPid < 0, startText);

  const execution = interactWithProcess({
    pid: virtualPid,
    input: 'setInterval(() => {}, 1000); console.log("ready");',
    timeout_ms: 30000,
  }, undefined, context);
  const child = await waitForExecution(context, virtualPid);
  return { virtualPid, child, execution };
}

const disposeContext = createProcessToolContext();
try {
  const { child, execution } = await startLongRunningNodeSession(disposeContext);
  const disposeChildPid = child.pid;
  await disposeProcessToolContext(disposeContext);
  await disposeProcessToolContext(disposeContext);
  assert.equal(disposeContext.virtualNodeSessions.size, 0);
  assert.equal(disposeContext.activeNodeExecutions.size, 0);
  assert.equal(isAlive(disposeChildPid), false, `dispose must stop node:local child ${disposeChildPid}`);
  const afterClose = await startProcess({ command: 'node:local', timeout_ms: 1000 }, undefined, disposeContext);
  assert.equal(afterClose.isError, true, 'a disposed process context must reject new virtual sessions');
  await execution;
} finally {
  await disposeProcessToolContext(disposeContext).catch(() => {});
}

const terminateContext = createProcessToolContext();
let terminateChildPid;
try {
  const { virtualPid, child, execution } = await startLongRunningNodeSession(terminateContext);
  terminateChildPid = child.pid;
  const result = await forceTerminate({ pid: virtualPid }, terminateContext);
  assert.equal(result.isError, undefined);
  assert.equal(terminateContext.virtualNodeSessions.has(virtualPid), false);
  assert.equal(isAlive(terminateChildPid), false, `force_terminate must stop node:local child ${terminateChildPid}`);
  await execution;
} finally {
  await disposeProcessToolContext(terminateContext).catch(() => {});
}

console.log('PASS node:local execution cleanup on context dispose and force_terminate');
