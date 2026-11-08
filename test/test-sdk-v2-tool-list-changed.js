import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PROJECT_ROOT, 'test', 'fixtures', 'sdk-v2-tool-list-changed-server.js');

export default async function runTests() {
  let changedResolve;
  const changedPromise = new Promise((resolve) => { changedResolve = resolve; });
  const changes = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client(
    { name: 'sdk-v2-tool-list-changed-probe', version: '1.0.0' },
    {
      capabilities: {},
      listChanged: {
        tools: {
          autoRefresh: true,
          debounceMs: 0,
          onChanged: (error, tools) => {
            changes.push({ error, tools });
            changedResolve();
          },
        },
      },
    },
  );
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await client.connect(transport, { timeout: 10_000 });
    assert.strictEqual(client.getServerCapabilities()?.tools?.listChanged, true,
      'server should advertise tools.listChanged=true');

    const initial = await client.listTools();
    assert.deepStrictEqual(initial.tools.map((tool) => tool.name), ['toggle_tools']);

    const trigger = await client.callTool({ name: 'toggle_tools', arguments: {} }, { timeout: 5_000 });
    assert.strictEqual(trigger.isError, undefined, 'trigger tool should succeed');

    await Promise.race([
      changedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for tools/list_changed')), 5_000)),
    ]);

    assert.strictEqual(changes.length, 1, `expected one list-changed callback; got ${changes.length}`);
    assert.strictEqual(changes[0].error, null, `callback should not receive an error: ${changes[0].error}`);
    assert.deepStrictEqual(changes[0].tools.map((tool) => tool.name), ['toggle_tools', 'dynamic_tool']);
    // The callback (stdout protocol) can arrive before the diagnostic stderr pipe
    // flushes, especially on POSIX. Wait briefly for the independent stream.
    const stderrDeadline = Date.now() + 1_500;
    while (!/TOOLS_LIST_CALL=2/.test(stderr) && Date.now() < stderrDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(stderr, /TOOLS_LIST_CALL=1/);
    assert.match(stderr, /TOOLS_LIST_CALL=2/,
      `client should automatically re-fetch tools after notification; stderr=${stderr}`);

    console.log('✓ server advertises tools.listChanged=true');
    console.log('✓ server.sendToolListChanged emits the standard notification');
    console.log('✓ SDK v2 client auto-refreshes tools/list after the notification');
    console.log('✓ onChanged receives the updated tool set');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
