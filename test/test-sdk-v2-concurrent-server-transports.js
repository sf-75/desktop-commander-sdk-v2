import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const serverModule = await import('../dist/server.js');
const { createServerInstance, handleInitializedClient } = serverModule;

function makePeer(serverName) {
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
  return { serverName, server, clientTransport, serverTransport, request, notify };
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
await peerA.server.connect(peerA.serverTransport);
await initialize(peerA, 'desktop-commander-app', 'instance-a');

const peerB = makePeer('B');
await peerB.server.connect(peerB.serverTransport);
await initialize(peerB, 'independent-test-client', 'instance-b');

// Both transports remain live. B's initialization must not change A's
// client-specific tool filtering.
const [toolsA, toolsB] = await Promise.all([
  peerA.request('tools/list'),
  peerB.request('tools/list'),
]);

const feedbackToolA = toolsA.result?.tools?.some((tool) => tool.name === 'give_feedback_to_desktop_commander') ?? false;
const feedbackToolB = toolsB.result?.tools?.some((tool) => tool.name === 'give_feedback_to_desktop_commander') ?? false;

assert.equal(feedbackToolA, false, 'Server A (desktop-commander-app) must hide the feedback tool after Server B initializes');
assert.equal(feedbackToolB, true, 'Server B must retain the feedback tool for its independent client');

await Promise.all([
  peerA.clientTransport.close(),
  peerB.clientTransport.close(),
  peerA.server.close(),
  peerB.server.close(),
]);

console.log('PASS concurrent independent transport client-state isolation');
