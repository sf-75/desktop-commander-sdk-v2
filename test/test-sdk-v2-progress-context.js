import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PROJECT_ROOT, 'test', 'fixtures', 'sdk-v2-progress-server.js');

export default async function runTests() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client(
    { name: 'sdk-v2-progress-probe', version: '1.0.0' },
    { capabilities: {} },
  );
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await client.connect(transport, { timeout: 10_000 });

    const updates = [];
    const result = await client.callTool(
      { name: 'progress_probe', arguments: {} },
      {
        timeout: 5_000,
        onprogress: (progress) => updates.push(progress),
      },
    );

    assert.strictEqual(result.isError, undefined, 'progress probe should complete successfully');
    assert.match(result.content?.[0]?.text ?? '', /progress probe complete/);
    assert.match(stderr, /PROGRESS_TOKEN_PRESENT=true/,
      `server should receive a progress token when onprogress is supplied; stderr=${stderr}`);
    assert.match(stderr, /PROGRESS_TOKEN_TYPE=(string|number)/,
      `progress token should be a protocol-supported string or number; stderr=${stderr}`);
    assert.deepStrictEqual(
      updates.map(({ progress, total, message }) => ({ progress, total, message })),
      [
        { progress: 1, total: 3, message: 'step 1' },
        { progress: 2, total: 3, message: 'step 2' },
        { progress: 3, total: 3, message: 'step 3' },
      ],
      `client should receive ordered progress updates; updates=${JSON.stringify(updates)}`,
    );

    stderr = '';
    const noProgressResult = await client.callTool(
      { name: 'progress_probe', arguments: {} },
      { timeout: 5_000 },
    );
    assert.strictEqual(noProgressResult.isError, undefined, 'request without onprogress should still succeed');
    assert.match(stderr, /PROGRESS_TOKEN_PRESENT=false/,
      `server should not receive a progress token without onprogress; stderr=${stderr}`);

    console.log('✓ SDK v2 client onprogress supplies a request progress token');
    console.log('✓ server ctx.mcpReq._meta exposes the progress token');
    console.log('✓ ctx.mcpReq.notify delivers ordered progress notifications');
    console.log('✓ requests without onprogress do not receive a progress token');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
