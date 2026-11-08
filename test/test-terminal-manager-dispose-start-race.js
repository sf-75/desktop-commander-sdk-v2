import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { TerminalManager } from '../dist/terminal-manager.js';

let realChild;
let manager;
let exposePid = false;
let signalSpawnCall;
const spawnCall = new Promise((resolve) => { signalSpawnCall = resolve; });

try {
  realChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  await once(realChild, 'spawn');

  const delayedChild = new EventEmitter();
  Object.defineProperties(delayedChild, {
    pid: { get: () => exposePid ? realChild.pid : undefined },
    exitCode: { get: () => realChild.exitCode },
    signalCode: { get: () => realChild.signalCode },
    stdin: { get: () => realChild.stdin },
    stdout: { get: () => realChild.stdout },
    stderr: { get: () => realChild.stderr },
  });
  delayedChild.kill = (signal) => realChild.kill(signal);
  realChild.on('exit', (code, signal) => delayedChild.emit('exit', code, signal));
  realChild.on('error', (error) => delayedChild.emit('error', error));

  manager = new TerminalManager();
  manager.spawnCommandProcess = () => {
    signalSpawnCall();
    return delayedChild;
  };

  const starting = manager.executeCommand('the injected child is used instead');
  await spawnCall;
  await new Promise((resolve) => setImmediate(resolve));

  let disposeResolved = false;
  const disposing = manager.dispose().then(() => { disposeResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposeResolved, false, 'dispose() must wait for a child whose spawn event is pending');

  exposePid = true;
  delayedChild.emit('spawn');
  await disposing;

  const result = await starting;
  assert.equal(result.pid, -1);
  assert.match(result.output, /session manager is closed/i);
  assert(realChild.exitCode !== null || realChild.signalCode !== null, 'the late-spawned child must be terminated');

  console.log('PASS TerminalManager.dispose waits for and terminates a child with a pending spawn event');
} finally {
  if (realChild && realChild.exitCode === null && realChild.signalCode === null) {
    realChild.kill('SIGKILL');
    await once(realChild, 'exit').catch(() => {});
  }
  await manager?.dispose().catch(() => {});
}
