import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'test', 'fixtures', 'sdk-v2-logging-server.js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function runTests() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT, stderr: 'pipe' });
  const client = new Client({ name: 'sdk-v2-logging-probe', version: '1.0.0' }, { capabilities: {} });
  const seen = [];
  client.setNotificationHandler('notifications/message', notification => {
    seen.push(notification.params.level);
  });
  try {
    await client.connect(transport, { timeout: 10_000 });
    await client.callTool({ name: 'emit_logs', arguments: {} }, { timeout: 5_000 });
    await sleep(50);
    assert.deepStrictEqual(seen, ['debug', 'info', 'warning', 'error']);

    seen.length = 0;
    await client.setLoggingLevel('warning', { timeout: 5_000 });
    await client.callTool({ name: 'emit_logs', arguments: {} }, { timeout: 5_000 });
    await sleep(50);
    assert.deepStrictEqual(seen, ['warning', 'error']);

    console.log('✓ logging capability auto-registers logging/setLevel');
    console.log('✓ sendLoggingMessage emits all levels before threshold');
    console.log('✓ logging/setLevel=warning filters debug/info');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
