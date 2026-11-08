import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { createServerInstance } = await import('../dist/server.js');
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServerInstance();
const responses = new Map();
const pidFile = path.join(os.tmpdir(), `dc-sdk-v2-node-local-preserve-${process.pid}.pid`);
let nextId = 1;
let childPid;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const text = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true,
    });
    return text.includes(`"${pid}"`);
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

clientTransport.onmessage = (message) => {
  if (!message || !Object.hasOwn(message, 'id')) return;
  const resolve = responses.get(message.id);
  if (resolve) {
    responses.delete(message.id);
    resolve(message);
  }
};

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    responses.set(id, resolve);
    void clientTransport.send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
      responses.delete(id);
      reject(error);
    });
  });
}

async function stopFixtureChild(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!isAlive(pid)) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // A child may naturally finish before test cleanup.
  }
  for (let n = 0; n < 100 && isAlive(pid); n++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(isAlive(pid), false, `Fixture node:local child ${pid} was not stopped by test cleanup`);
}

try {
  await server.connect(serverTransport);
  const initialized = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'node-local-lifetime-test', version: '1.0.0' },
  });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const created = await request('tools/call', {
    name: 'start_process',
    arguments: { command: 'node:local', timeout_ms: 30000 },
  });
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const createdText = created.result?.content?.map((x) => x.text ?? '').join('\n') ?? '';
  const virtualPid = Number(/PID (-\d+)/.exec(createdText)?.[1]);
  assert(Number.isInteger(virtualPid) && virtualPid < 0, createdText);

  await fs.rm(pidFile, { force: true });
  const input = [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'await new Promise((resolve) => setTimeout(resolve, 30000));',
  ].join('\n');
  const execution = request('tools/call', {
    name: 'interact_with_process',
    arguments: { pid: virtualPid, input, timeout_ms: 30000 },
  });
  // Closing the transport may discard the pending RPC response.
  void execution.catch(() => {});

  for (let n = 0; n < 100; n++) {
    try {
      childPid = Number(await fs.readFile(pidFile, 'utf8'));
      if (Number.isInteger(childPid) && childPid > 0) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(Number.isInteger(childPid) && childPid > 0, 'Node-local child did not report its PID');
  assert.equal(isAlive(childPid), true, 'Fixture node-local script must be running before close');

  await serverTransport.close();
  await server.close();
  assert.equal(isAlive(childPid), true,
    `Server.close() must not kill an in-flight node:local script (PID ${childPid})`);

  console.log('PASS Server.close preserves an in-flight node:local script');
} finally {
  await stopFixtureChild(childPid);
  await server.close().catch(() => {});
  await clientTransport.close().catch(() => {});
  await fs.rm(pidFile, { force: true }).catch(() => {});
}
