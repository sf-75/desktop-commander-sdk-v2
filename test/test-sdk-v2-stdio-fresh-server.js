import assert from 'node:assert/strict';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const instances = [];

  const handle = serveStdio(({ era }) => {
    const server = new Server(
      { name: `fresh-${era}-${instances.length + 1}`, version: '1.0.0' },
      { capabilities: { tools: {} }, supportedProtocolVersions: ['2026-07-28', '2025-11-25'] },
    );
    instances.push({ era, server });
    return server;
  }, { transport: serverTransport });

  const responses = [];
  clientTransport.onmessage = (message) => responses.push(message);
  await clientTransport.start();
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await clientTransport.send({
      jsonrpc: '2.0', id: 'probe', method: 'server/discover', params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });
    await waitFor(() => responses.some((message) => message.id === 'probe'), 'modern discover response');
    assert.deepEqual(instances.map(({ era }) => era), ['modern']);

    await clientTransport.send({
      jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'fresh-server-contract-test', version: '1.0.0' },
      },
    });
    await waitFor(() => responses.some((message) => message.id === 'initialize'), 'legacy initialize response');

    assert.deepEqual(
      instances.map(({ era }) => era),
      ['modern', 'legacy'],
      'probe-to-legacy fallback must construct a fresh server for the legacy connection',
    );
    assert.notEqual(instances[0].server, instances[1].server, 'serveStdio factory instances must not be reused after probe discard');
    assert.equal(responses.find((message) => message.id === 'initialize')?.result?.protocolVersion, '2025-11-25');
    console.log('PASS: serveStdio probe-to-legacy fallback constructs a fresh Server instance');
    return true;
  } finally {
    await handle.close().catch(() => {});
    await clientTransport.close().catch(() => {});
  }
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

runIfMain(import.meta.url, runTests);
