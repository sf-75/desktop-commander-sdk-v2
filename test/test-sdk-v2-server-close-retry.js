import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SearchManager } from '../dist/search-manager.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { createServerInstance } = await import('../dist/server.js');
const originalDispose = SearchManager.prototype.dispose;
let disposeAttempts = 0;
SearchManager.prototype.dispose = function () {
  disposeAttempts += 1;
  if (disposeAttempts === 1) return Promise.reject(new Error('injected transient cleanup failure'));
  return originalDispose.call(this);
};

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServerInstance();
const pending = new Map();
let nextId = 1;

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
    clientInfo: { name: 'server-close-retry-test', version: '1.0.0' },
  });
  assert.equal(initialized.error, undefined, JSON.stringify(initialized.error));
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const listed = await request('tools/call', { name: 'list_sessions', arguments: {} });
  assert.equal(listed.error, undefined, JSON.stringify(listed.error));

  await assert.rejects(server.close(), /injected transient cleanup failure/);
  await server.close();
  assert.equal(disposeAttempts, 2, 'a later Server.close() must retry runtime cleanup after a transient failure');

  console.log('PASS Server.close retries runtime cleanup after a transient failure');
} finally {
  await clientTransport.close().catch(() => {});
  await server.close().catch(() => {});
  SearchManager.prototype.dispose = originalDispose;
}
