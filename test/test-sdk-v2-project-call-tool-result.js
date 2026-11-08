import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { closeClient } from './helpers/close-client.js';
import { runIfMain } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PROJECT_ROOT, 'test', 'fixtures', 'sdk-v2-project-call-tool-result-server.js');

async function waitForStderr(getStderr, pattern, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(getStderr()) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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
    { name: 'sdk-v2-project-call-tool-result-probe', version: '1.0.0' },
    { capabilities: {} },
  );
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

  try {
    await client.connect(transport, { timeout: 10_000 });

    const objectResult = await client.callTool(
      { name: 'object_probe', arguments: {} },
      { timeout: 5_000 },
    );
    assert.deepStrictEqual(objectResult.structuredContent, { answer: 42 });
    assert.strictEqual(objectResult.content?.[0]?.text, 'object probe');

    const scalarResult = await client.callTool(
      { name: 'scalar_probe', arguments: {} },
      { timeout: 5_000 },
    );
    await waitForStderr(() => stderr, /PROJECTED_SCALAR_PROBE=/);

    assert.match(stderr, /NEGOTIATED_VERSION=2025-11-25/,
      `default SDK v2 client should negotiate 2025-11-25 legacy mode; stderr=${stderr}`);
    assert.match(stderr,
      /PROJECTED_OBJECT_PROBE=\{"content":\[\{"type":"text","text":"object probe"\}\],"structuredContent":\{"answer":42\}\}/,
      `object-shaped structuredContent should remain unchanged; stderr=${stderr}`);
    assert.match(stderr,
      /PROJECTED_SCALAR_PROBE=\{"content":\[\{"type":"text","text":"\\"scalar-value\\""\}\],"structuredContent":\{"result":"scalar-value"\}\}/,
      `scalar structuredContent should gain a text fallback and legacy result wrapper; stderr=${stderr}`);

    assert.deepStrictEqual(scalarResult.structuredContent, { result: 'scalar-value' },
      '2025 client should receive the legacy object wrapper emitted on the wire');
    assert.strictEqual(scalarResult.content?.[0]?.text, '"scalar-value"',
      '2025 client should receive the text fallback added by the projection');

    console.log('✓ SDK v2 legacy mode negotiates protocol 2025-11-25');
    console.log('✓ object structuredContent is projection-stable');
    console.log('✓ scalar structuredContent gets text fallback + {result: ...} wire wrapper');
    console.log('✓ 2025 client observes the projected legacy-compatible result');
    return true;
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, runTests);
