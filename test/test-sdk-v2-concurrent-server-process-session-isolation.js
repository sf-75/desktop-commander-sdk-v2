import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { createServerInstance } = await import('../dist/server.js');

function makePeer() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServerInstance();
  const pending = new Map();
  clientTransport.onmessage = (message) => {
    if (message && Object.hasOwn(message, 'id')) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  };
  let nextId = 1;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    void clientTransport.send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
      pending.delete(id);
      reject(error);
    });
  });
  const notify = (method, params = {}) => clientTransport.send({ jsonrpc: '2.0', method, params });
  return { server, clientTransport, serverTransport, request, notify };
}

async function initialize(peer, clientName) {
  const response = await peer.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: clientName, version: '1.0.0' },
  });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  await peer.notify('notifications/initialized');
}

async function callTool(peer, name, args = {}) {
  const response = await peer.request('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
}

const peerA = makePeer();
const peerB = makePeer();
let processPid;

try {
  await peerA.server.connect(peerA.serverTransport);
  await initialize(peerA, 'process-session-owner-a');
  await peerB.server.connect(peerB.serverTransport);
  await initialize(peerB, 'process-session-observer-b');

  const real = await callTool(peerA, 'start_process', {
    command: 'node -e "setInterval(() => {}, 1000)"',
    timeout_ms: 300,
  });
  const startText = real.content?.map((item) => item.text ?? '').join('\n') ?? '';
  processPid = Number(/Process started with PID (\d+)/.exec(startText)?.[1]);
  assert(Number.isInteger(processPid) && processPid > 0,
    `long-running process should return its PID in the response: ${JSON.stringify(real)}`);

  const sessionsB = await callTool(peerB, 'list_sessions');
  const sessionsBText = sessionsB.content?.map((item) => item.text ?? '').join('\n') ?? '';
  assert(!new RegExp(`\\bPID: ${processPid}\\b`).test(sessionsBText),
    `Server B must not enumerate Server A's terminal session ${processPid}; got ${sessionsBText}`);

  const outputB = await callTool(peerB, 'read_process_output', { pid: processPid, timeout_ms: 0 });
  const outputBText = outputB.content?.map((item) => item.text ?? '').join('\\n') ?? '';
  assert.equal(outputB.isError, true, `Server B must not read Server A's session: ${outputBText}`);
  assert(outputBText.includes(`No session found for PID ${processPid}`), outputBText);

  const terminateB = await callTool(peerB, 'force_terminate', { pid: processPid });
  const terminateBText = terminateB.content?.map((item) => item.text ?? '').join('\\n') ?? '';
  assert(terminateBText.includes(`No active session found for PID ${processPid}`), terminateBText);

  const ownSessionsA = await callTool(peerA, 'list_sessions');
  const sessionsAText = ownSessionsA.content?.map((item) => item.text ?? '').join('\n') ?? '';
  assert(new RegExp(`\\bPID: ${processPid}\\b`).test(sessionsAText),
    'Server A should retain its own terminal session');
} finally {
  if (Number.isInteger(processPid) && processPid > 0) {
    await callTool(peerA, 'force_terminate', { pid: processPid }).catch(() => {});
  }
  await Promise.all([
    peerA.clientTransport.close().catch(() => {}),
    peerB.clientTransport.close().catch(() => {}),
    peerA.server.close().catch(() => {}),
    peerB.server.close().catch(() => {}),
  ]);
}

console.log('PASS per-Server process-session isolation');
