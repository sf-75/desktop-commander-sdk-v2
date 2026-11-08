import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createProcessToolContext,
  disposeProcessToolContext,
} from '../dist/tools/improved-process-tools.js';

const context = createProcessToolContext();
const fakeProcess = new EventEmitter();
fakeProcess.pid = -1;
fakeProcess.exitCode = null;
fakeProcess.signalCode = null;
fakeProcess.kill = () => true;
fakeProcess.stdout = undefined;
fakeProcess.stderr = undefined;
context.activeNodeExecutions.set(42, new Set([fakeProcess]));

// On Windows, taskkill reliably reports failure for this non-existent PID.
// POSIX treats ESRCH as already terminated, so this failure-injection case is
// intentionally skipped there rather than risking a signal to a real process.
if (process.platform === 'win32') {
  await assert.rejects(
    disposeProcessToolContext(context),
    /Could not terminate every node:local execution process/,
  );
  assert(context.activeNodeExecutions.get(42)?.has(fakeProcess),
    'a process that could not be terminated must remain tracked');

  fakeProcess.exitCode = 0;
  await disposeProcessToolContext(context);
  assert.equal(context.activeNodeExecutions.has(42), false,
    'successful retry must release the previously failed process reference');
  console.log('PASS ProcessToolContext retries disposal after a transient termination failure');
} else {
  // Intercept only the sentinel PID (-1): on POSIX, process.kill(-1, signal)
  // targets the process group, so never let the real implementation receive it.
  // This gives the process-tree terminator a deterministic, OS-safe EPERM seam.
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid === -1) {
      if (signal === 0) return true; // Keep the fake process "alive" during polling.
      throw Object.assign(new Error('injected POSIX termination failure'), { code: 'EPERM' });
    }
    return Reflect.apply(originalKill, process, [pid, signal]);
  };

  try {
    await assert.rejects(
      disposeProcessToolContext(context),
      /Could not terminate every node:local execution process/,
    );
    assert(context.activeNodeExecutions.get(42)?.has(fakeProcess),
      'a process that could not be terminated must remain tracked');

    fakeProcess.exitCode = 0;
    await disposeProcessToolContext(context);
    assert.equal(context.activeNodeExecutions.has(42), false,
      'successful retry must release the previously failed process reference');
    console.log('PASS ProcessToolContext retries disposal after an injected POSIX termination failure');
  } finally {
    process.kill = originalKill;
  }
}
