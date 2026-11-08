import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const serverModule = await import('../dist/server.js');
const { createServerInstance, handleInitializedClient } = serverModule;

function makePeer(label) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServerInstance();
  server.oninitialized = () => handleInitializedClient(server);
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
  return { label, server, clientTransport, serverTransport, request, notify };
}

async function initialize(peer, clientName, clientVersion) {
  const response = await peer.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: clientName, version: clientVersion },
  });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  await peer.notify('notifications/initialized');
}

const peerA = makePeer('A');
const peerB = makePeer('B');
try {
  await peerA.server.connect(peerA.serverTransport);
  await initialize(peerA, 'history-owner-a', 'instance-a');
  await peerB.server.connect(peerB.serverTransport);
  await initialize(peerB, 'history-reader-b', 'instance-b');

  // A performs a harmless read-only operation with a unique argument marker.
  // Its result may be an error if the synthetic path does not exist; the call
  // is still recorded in the intentionally host-wide local history. The test
  // documents that all trusted transports in this process can read that log.
  const marker = 'sdk-v2-history-client-a-marker-20261104';
  await peerA.request('tools/call', {
    name: 'get_file_info',
    arguments: { path: marker },
  });

  // B asks for its recent host history through its own live MCP transport.
  const historyResponse = await peerB.request('tools/call', {
    name: 'get_recent_tool_calls',
    arguments: { maxResults: 1000 },
  });
  assert.equal(historyResponse.error, undefined, JSON.stringify(historyResponse.error));
  const text = historyResponse.result?.content?.map((item) => item.text ?? '').join('\n') ?? '';
  assert.ok(
    text.includes(marker),
    'Client B currently receives Client A\'s tool arguments through get_recent_tool_calls',
  );

  console.log('CONFIRMED cross-transport history visibility: client B can read client A tool arguments');
} finally {
  await Promise.allSettled([
    peerA.clientTransport.close(),
    peerB.clientTransport.close(),
    peerA.server.close(),
    peerB.server.close(),
  ]);
}
