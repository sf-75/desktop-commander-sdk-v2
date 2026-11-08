import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'test', 'fixtures', 'sdk-v2-custom-stdio-logging-server.js');

export default async function runTests() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT, stderr: 'pipe' });
  const client = new Client({ name: 'custom-stdio-logging-client', version: '1.0.0' }, { capabilities: {} });
  const logs = [];
  client.setNotificationHandler('notifications/message', (notification) => logs.push(notification.params));

  try {
    await client.connect(transport, { timeout: 10_000 });

    logs.length = 0;
    const noiseResult = await client.callTool({ name: 'emit_stdout_noise', arguments: {} }, { timeout: 5_000 });
    assert.strictEqual(noiseResult.content?.[0]?.text, 'noise-ok');
    const noiseDeadline = Date.now() + 2_000;
    while ((!logs.some(log => log.data === '{"id":"not-protocol","message":"json-like-log"}')
      || !logs.some(log => log.data === 'buffer-noise'))
      && Date.now() < noiseDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(logs.some(log => log.data === '{"id":"not-protocol","message":"json-like-log"}'));
    assert.ok(logs.some(log => log.data === 'buffer-noise'));

    await client.setLoggingLevel('warning', { timeout: 5_000 });
    logs.length = 0;

    const result = await client.callTool({ name: 'emit_logs', arguments: {} }, { timeout: 5_000 });
    assert.strictEqual(result.content?.[0]?.text, 'ok');

    const deadline = Date.now() + 2_000;
    while (!logs.some(log => log.level === 'warning' && log.data === 'warning-message')
      && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    assert.ok(logs.some(log => log.level === 'warning' && log.data === 'warning-message'));
    assert.ok(!logs.some(log => log.level === 'debug' && log.data === 'debug-message'));
    console.log('✓ custom stdio logging uses SDK logging/setLevel filtering end-to-end');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
