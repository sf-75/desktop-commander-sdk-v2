import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';

function isProcessAlive(pid) {
  if (process.platform === 'win32') {
    const taskList = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return taskList.includes(`"${pid}"`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { createServerInstance } = await import('../dist/server.js');
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServerInstance();
let serverCloseHookCalled = false;
const originalServerOnClose = server.onclose;
server.onclose = () => {
  serverCloseHookCalled = true;
  originalServerOnClose?.();
};
const pending = new Map();
let nextId = 1;
let processPid;
let inFlightPid;
let shouldForceCleanup = false;
const inFlightPidFile = path.join(os.tmpdir(), `dc-sdk-v2-close-${process.pid}.pid`);

clientTransport.onmessage = (message) => {
  if (message && Object.hasOwn(message, 'id')) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
};

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    void clientTransport.send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
      pending.delete(id);
      reject(error);
    });
  });
}

try {
  await server.connect(serverTransport);
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'server-close-cleanup-test', version: '1.0.0' },
  });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const started = await request('tools/call', {
    name: 'start_process',
    arguments: {
      command: 'node -e "setTimeout(() => {}, 30000)"',
      timeout_ms: 250,
    },
  });
  assert.equal(started.error, undefined, JSON.stringify(started.error));
  const output = started.result?.content?.map((item) => item.text ?? '').join('\n') ?? '';
  processPid = Number(/Process started with PID (\d+)/.exec(output)?.[1]);
  assert(Number.isInteger(processPid) && processPid > 0, output);
  shouldForceCleanup = true;

  // Keep a second tool request in flight while the Server begins shutting down.
  // The SDK may discard its response on close; it must not kill the
  // user-started child process even while the tool request remains in flight.
  await fs.rm(inFlightPidFile, { force: true });
  const inFlightStart = request('tools/call', {
    name: 'start_process',
    arguments: {
      command: `node -e "require('fs').writeFileSync(require('os').tmpdir() + '/dc-sdk-v2-close-${process.pid}.pid', String(process.pid)); setTimeout(() => {}, 30000)"`,
      timeout_ms: 30000,
    },
  });
  // The SDK may intentionally discard this response when the transport closes.
  void inFlightStart.catch(() => {});
  let inFlightPidText;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      inFlightPidText = await fs.readFile(inFlightPidFile, 'utf8');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert(inFlightPidText, 'In-flight process did not publish its PID before shutdown');
  inFlightPid = Number(inFlightPidText);
  assert(Number.isInteger(inFlightPid) && inFlightPid > 0, inFlightPidText);

  // Transport-initiated close must start cleanup too; public close() callers
  // still need to be able to await the same shutdown operation.
  await serverTransport.close();
  await Promise.all([server.close(), server.close(), server.close()]);
  assert.equal(isProcessAlive(inFlightPid), true, `Server.close() must preserve in-flight user process (PID ${inFlightPid})`);
  assert.equal(serverCloseHookCalled, true, 'Server.close() must invoke the Server onclose hook');
  await clientTransport.close().catch(() => {});

  const processStillAlive = isProcessAlive(processPid);
  shouldForceCleanup = processStillAlive;

  assert.equal(
    processStillAlive,
    true,
    `Server.close() must preserve its user-started process session (PID ${processPid})`,
  );
} finally {
  await clientTransport.close().catch(() => {});
  await server.close().catch(() => {});

  const forceTerminateAndWait = async (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      // The process may already have exited or been terminated by the server.
    }
    for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isProcessAlive(pid), false, `Test cleanup could not terminate child process (PID ${pid})`);
  };

  if (shouldForceCleanup) await forceTerminateAndWait(processPid);
  // Recover a PID published just before an earlier assertion or timeout.
  if (!Number.isInteger(inFlightPid) || inFlightPid <= 0) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        inFlightPid = Number(await fs.readFile(inFlightPidFile, 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  // Always clean up the in-flight child if its PID was published, including
  // when an assertion fails before Server.close() completes successfully.
  await forceTerminateAndWait(inFlightPid);
  await fs.rm(inFlightPidFile, { force: true }).catch(() => {});
}

console.log('PASS Server.close preserves user-started process sessions');
