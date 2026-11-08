/**
 * Deterministic MCP process termination contract tests.
 *
 * OS process creation, PID discovery, WMI and taskkill execution are deliberately
 * absent: these test our request handling, session state and retry semantics.
 * A separate Windows integration test exercises the real adapter.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { TerminalManager, terminalManager } from '../dist/terminal-manager.js';
import { terminateProcessTree } from '../dist/utils/process-tree.js';
import { forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

function fakeChild(pid = 64001) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  child.finish = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  return child;
}

function mountFixtureSession(manager, pid, child = fakeChild(pid)) {
  // TypeScript private, not an ECMAScript #private field: inject a minimal
  // controlled fixture instead of launching a real OS process.
  manager.sessions.set(pid, { pid, process: child, startTime: new Date() });
  return child;
}

async function checkMissingPid() {
  let calls = 0;
  const manager = new TerminalManager(async () => { calls++; return true; });
  assert.equal(await manager.forceTerminate(64021), 'not_found');
  assert.equal(calls, 0, 'Unknown session must not invoke process termination');
  console.log('PASS unknown PID returns not_found without any OS operation');
}

async function checkConcurrentSuccess() {
  let calls = 0;
  let resolveTermination;
  const gate = new Promise(resolve => { resolveTermination = resolve; });
  const manager = new TerminalManager(async child => {
    calls++;
    assert.equal(child.pid, 64022);
    return gate;
  });
  mountFixtureSession(manager, 64022);
  const a = manager.forceTerminate(64022);
  const b = manager.forceTerminate(64022);
  assert.equal(calls, 1, 'Concurrent calls must share one termination attempt');
  resolveTermination(true);
  assert.deepEqual(await Promise.all([a, b]), ['terminated', 'terminated']);
  assert.equal(await manager.forceTerminate(64022), 'terminated');
  assert.equal(calls, 1, 'Completed successful termination must not be repeated');
  console.log('PASS concurrent requests de-duplicated and success cached');
}

async function checkFailureRetry() {
  let calls = 0;
  const manager = new TerminalManager(async () => ++calls > 1);
  const child = mountFixtureSession(manager, 64023);
  assert.equal(await manager.forceTerminate(64023), 'failed');
  assert.equal(calls, 1);
  assert.equal(manager.sessions.get(64023).termination, undefined,
    'Failed termination must be forgotten so the next request retries');
  assert.equal(await manager.forceTerminate(64023), 'terminated');
  assert.equal(calls, 2);
  assert.equal(await manager.forceTerminate(64023), 'terminated');
  assert.equal(calls, 2);
  assert.deepEqual(child.signals, [], 'The manager must not send independent OS kills');
  console.log('PASS failed termination retries, then caches success');
}

async function checkConcurrentFailureRetry() {
  let calls = 0;
  let resolveFirst;
  const pending = new Promise(resolve => { resolveFirst = resolve; });
  const manager = new TerminalManager(async () => {
    calls++;
    return calls === 1 ? pending : true;
  });
  mountFixtureSession(manager, 64024);
  const a = manager.forceTerminate(64024);
  const b = manager.forceTerminate(64024);
  assert.equal(calls, 1);
  resolveFirst(false);
  assert.deepEqual(await Promise.all([a, b]), ['failed', 'failed']);
  assert.equal(calls, 1);
  assert.equal(await manager.forceTerminate(64024), 'terminated');
  assert.equal(calls, 2);
  console.log('PASS concurrent failure coalesced; later request independently retries');
}

async function checkToolResponses() {
  const original = terminalManager.forceTerminate;
  const recorded = [];
  try {
    terminalManager.forceTerminate = async pid => {
      recorded.push(pid);
      return 'terminated';
    };
    const success = await forceTerminate({ pid: 64031 });
    assert.equal(success.isError, undefined);
    assert.equal(success.content[0].text, 'Successfully initiated termination of session 64031');

    terminalManager.forceTerminate = async pid => {
      recorded.push(pid);
      return 'failed';
    };
    const failure = await forceTerminate({ pid: 64032 });
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /Could not terminate every process of session 64032/);

    terminalManager.forceTerminate = async pid => {
      recorded.push(pid);
      return 'not_found';
    };
    const missing = await forceTerminate({ pid: 64033 });
    assert.equal(missing.isError, undefined);
    assert.equal(missing.content[0].text, 'No active session found for PID 64033');

    const invalid = await forceTerminate({ pid: 'not-a-number' });
    assert.equal(invalid.isError, true);
    assert.deepEqual(recorded, [64031, 64032, 64033],
      'Invalid arguments must not reach the manager');
  } finally {
    terminalManager.forceTerminate = original;
  }
  console.log('PASS MCP tool response mapping and validation');
}

async function checkWindowsAdapter() {
  if (process.platform !== 'win32') {
    console.log('SKIP Windows-only argv adapter: verified on Windows test runner');
    return;
  }
  const child = fakeChild(64035);
  let invoked = 0;
  const success = await terminateProcessTree(child, async (file, args) => {
    invoked++;
    assert.equal(path.basename(file).toLowerCase(), 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '64035', '/T', '/F']);
    child.finish();
    return '';
  });
  assert.equal(success, true);
  assert.equal(invoked, 1);
  assert.deepEqual(child.signals, []);
  const alreadyExited = await terminateProcessTree(child, async () => {
    throw new Error('A completed child must not trigger an OS call');
  });
  assert.equal(alreadyExited, true);
  console.log('PASS Windows adapter issues exact taskkill command and handles successful child exit');
}

async function checkWindowsAdapterFailure() {
  if (process.platform !== 'win32') return;
  const child = fakeChild(64036);
  let invoked = 0;
  const result = await terminateProcessTree(child, async (file, args) => {
    invoked++;
    assert.equal(path.basename(file).toLowerCase(), 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '64036', '/T', '/F']);
    throw new Error('INJECTED_OS_ERROR');
  });
  assert.equal(result, false, 'OS failure must never be reported as success');
  assert.equal(invoked, 1);
  assert.deepEqual(child.signals, ['SIGKILL'],
    'On adapter failure, fallback kill is attempted on only the known root');
  console.log('PASS Windows adapter failure propagates as false and root fallback is attempted');
}

async function checkWindowsAdapterNeverReportsPrematureSuccess() {
  if (process.platform !== 'win32') return;
  const child = fakeChild(64037);
  let invocations = 0;
  const result = await terminateProcessTree(child, async (file, args) => {
    invocations++;
    assert.equal(path.basename(file).toLowerCase(), 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '64037', '/T', '/F']);
    // An OS command's success exit code alone does not prove that the
    // associated process has exited. Intentionally leave the fake child alive.
    return '';
  });
  assert.equal(result, false, 'Do not claim termination before the root exits');
  assert.equal(invocations, 1);
  console.log('PASS taskkill command success without child exit is not falsely reported as terminated');
}

async function run() {
  await checkMissingPid();
  await checkConcurrentSuccess();
  await checkFailureRetry();
  await checkConcurrentFailureRetry();
  await checkToolResponses();
  await checkWindowsAdapter();
  await checkWindowsAdapterFailure();
  await checkWindowsAdapterNeverReportsPrematureSuccess();
  console.log('PASS MCP termination contract: 8 deterministic checks, zero OS process fixtures');
}
runIfMain(import.meta.url, run);
export default run;
