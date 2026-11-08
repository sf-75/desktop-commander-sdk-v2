import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { createServerInstance } = await import('../dist/server.js');
const { SearchManager } = await import('../dist/search-manager.js');
const originalDispose = SearchManager.prototype.dispose;
let disposeCount = 0;
let holdNextDispose = false;
let releaseHeldDispose;
let heldDisposeStartedResolve;
const heldDisposeStarted = new Promise((resolve) => { heldDisposeStartedResolve = resolve; });
const heldDisposeGate = new Promise((resolve) => { releaseHeldDispose = resolve; });
SearchManager.prototype.dispose = function () {
  disposeCount++;
  const disposing = originalDispose.call(this);
  if (!holdNextDispose) return disposing;
  holdNextDispose = false;
  heldDisposeStartedResolve();
  return disposing.then(() => heldDisposeGate);
};

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
let sessionId;

try {
  await peerA.server.connect(peerA.serverTransport);
  await initialize(peerA, 'search-session-owner-a');
  await peerB.server.connect(peerB.serverTransport);
  await initialize(peerB, 'search-session-observer-b');

  const started = await callTool(peerA, 'start_search', {
    path: testDirectory,
    pattern: 'test-sdk-v2-concurrent-server-process-session-isolation.js',
    searchType: 'files',
    earlyTermination: true,
    timeout_ms: 10000,
  });
  const startText = started.content?.map((item) => item.text ?? '').join('\n') ?? '';
  sessionId = /session: (search_[^\s]+)/.exec(startText)?.[1];
  assert(sessionId, `start_search should return a session ID: ${JSON.stringify(started)}`);

  const searchesB = await callTool(peerB, 'list_searches');
  const searchesBText = searchesB.content?.map((item) => item.text ?? '').join('\n') ?? '';
  assert(!searchesBText.includes(sessionId),
    `Server B must not enumerate Server A's search session ${sessionId}; got ${searchesBText}`);

  const resultsB = await callTool(peerB, 'get_more_search_results', { sessionId, offset: 0, length: 5 });
  const resultsBText = resultsB.content?.map((item) => item.text ?? '').join('\\n') ?? '';
  assert.equal(resultsB.isError, true, `Server B must not read Server A's search results: ${resultsBText}`);
  assert(resultsBText.toLowerCase().includes('not found'), resultsBText);

  const stopB = await callTool(peerB, 'stop_search', { sessionId });
  const stopBText = stopB.content?.map((item) => item.text ?? '').join('\\n') ?? '';
  assert(stopBText.includes('not found or already completed'), stopBText);

  const ownSearchesA = await callTool(peerA, 'list_searches');
  const searchesAText = ownSearchesA.content?.map((item) => item.text ?? '').join('\n') ?? '';
  assert(searchesAText.includes(sessionId), 'Server A should retain its own search session');
} finally {
  if (sessionId) await callTool(peerA, 'stop_search', { sessionId }).catch(() => {});

  // Server.close() must not resolve merely because the SDK's synchronous
  // onclose hook returned; it must await the Server-owned search cleanup.
  holdNextDispose = true;
  let serverACloseResolved = false;
  const closingServerA = peerA.server.close().then(() => { serverACloseResolved = true; });
  try {
    await heldDisposeStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(serverACloseResolved, false, 'Server.close() must await SearchManager.dispose()');
  } finally {
    releaseHeldDispose();
  }
  await closingServerA;

  await Promise.all([
    peerA.clientTransport.close().catch(() => {}),
    peerB.clientTransport.close().catch(() => {}),
    peerB.server.close().catch(() => {}),
  ]);
  SearchManager.prototype.dispose = originalDispose;
  assert(disposeCount >= 2, `each closed Server should dispose its own SearchManager; got ${disposeCount}`);
}

console.log('PASS per-Server search-session isolation and cleanup');
