import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'test', 'fixtures', 'sdk-v2-custom-initialize-server.js');

export default async function runTests() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT, stderr: 'pipe' });
  const client = new Client({ name: 'custom-init-client', version: '9.9.9' }, { capabilities: { experimental: { probe: {} } } });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = await client.callTool({ name: 'state', arguments: {} }, { timeout: 5_000 });
    const state = JSON.parse(result.content[0].text);
    assert.strictEqual(state.version, null);
    assert.strictEqual(state.clientVersion, null);
    assert.strictEqual(state.clientCapabilities, null);
    console.log('✓ overriding initialize bypasses SDK negotiated protocol state');
    console.log('✓ overriding initialize bypasses SDK client version state');
    console.log('✓ overriding initialize bypasses SDK client capabilities state');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
