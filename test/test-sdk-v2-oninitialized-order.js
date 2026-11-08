import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'test', 'fixtures', 'sdk-v2-oninitialized-order-server.js');

export default async function runTests() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT, stderr: 'pipe' });
  const client = new Client({ name: 'oninitialized-order-client', version: '1.2.3' }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = await client.callTool({ name: 'state', arguments: {} }, { timeout: 5_000 });
    const state = JSON.parse(result.content[0].text);
    assert.strictEqual(state.synchronousInitializedWorkDone, true);
    assert.strictEqual(state.version, '2025-11-25');
    assert.strictEqual(state.clientName, 'oninitialized-order-client');
    assert.strictEqual(state.clientCapabilitiesPresent, true);
    assert.strictEqual(client.getInstructions(), 'fixture instructions');
    console.log('✓ synchronous oninitialized work completes before the next tool call');
    console.log('✓ built-in initialize populates negotiated protocol, client identity, and capabilities');
    console.log('✓ constructor instructions reach the client');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
