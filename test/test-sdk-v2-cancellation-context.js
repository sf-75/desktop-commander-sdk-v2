import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PROJECT_ROOT, 'test', 'fixtures', 'sdk-v2-cancellation-server.js');

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export default async function runTests() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client(
    { name: 'sdk-v2-cancellation-probe', version: '1.0.0' },
    { capabilities: {} },
  );
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await client.connect(transport, { timeout: 10_000 });

    const controller = new AbortController();
    const call = client.callTool(
      { name: 'slow_cancel_probe', arguments: {} },
      { signal: controller.signal },
    );

    await waitFor(() => stderr.includes('CTX_SIGNAL_READY'), 2_000, 'server request context');
    assert.match(stderr, /CTX_SIGNAL_READY aborted=false/,
      `handler should receive a live request signal before cancellation; stderr=${stderr}`);

    controller.abort('sdk-v2-cancel-probe');

    let rejected = false;
    try {
      await call;
    } catch (error) {
      rejected = true;
      assert.match(String(error), /sdk-v2-cancel-probe|cancel/i,
        `client rejection should describe cancellation; got ${String(error)}`);
    }
    assert.strictEqual(rejected, true, 'client call should reject after AbortController.abort()');

    await waitFor(() => stderr.includes('CTX_SIGNAL_ABORTED'), 2_000, 'server-side abort signal');
    assert.match(stderr, /CTX_SIGNAL_ABORTED reason=.*sdk-v2-cancel-probe/,
      `server should observe the client cancellation reason; stderr=${stderr}`);
    assert(!stderr.includes('CTX_SIGNAL_NOT_ABORTED'),
      `server work must stop after cancellation; stderr=${stderr}`);

    console.log('✓ SDK v2 request context exposes mcpReq.signal');
    console.log('✓ client AbortController cancellation rejects the call');
    console.log('✓ cancellation reaches the server signal with the reason');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
