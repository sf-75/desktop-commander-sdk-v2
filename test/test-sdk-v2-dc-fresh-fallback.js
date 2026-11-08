import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const child = spawn(process.execPath, [serverPath, '--no-onboarding'], {
  cwd: path.join(here, '..'),
  env: {
    ...process.env,
    DC_REMOTE_DEVICE: 'true',
    DC_SDK_V2_EXPERIMENTAL_MRTR: '1',
    DC_SDK_V2_PLAYGROUND: '1',
    DC_SDK_V2_FORCE_LEGACY_STDIO: '0',
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const lines = readline.createInterface({ input: child.stdout });
const responses = lines[Symbol.asyncIterator]();

async function readJsonLine(timeoutMs = 15_000) {
  let timer;
  try {
    const next = responses.next();
    const result = await Promise.race([
      next,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out waiting for JSON-RPC response')), timeoutMs);
      }),
    ]);
    if (result.done) throw new Error('server stdout closed before JSON-RPC response');
    return JSON.parse(result.value);
  } finally {
    clearTimeout(timer);
  }
}

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

async function readResponse(id, maxMessages = 64) {
  for (let i = 0; i < maxMessages; i += 1) {
    const message = await readJsonLine();
    if (message.id === id) return message;
  }
  throw new Error(`timed out waiting for JSON-RPC response id ${id}`);
}

try {
  await new Promise(resolve => setTimeout(resolve, 500));

  send({
    jsonrpc: '2.0',
    id: 'modern-probe',
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });

  const discover = await readResponse('modern-probe');
  assert.equal(discover.error, undefined, 'modern server/discover probe must succeed');
  assert.ok(discover.result?.supportedVersions?.includes('2026-07-28'));

  // The SDK discards the modern probe instance and calls the factory again
  // when the client falls back to the transitional 2025 initialize handshake.
  send({
    jsonrpc: '2.0',
    id: 'legacy-initialize',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'dc-fresh-fallback-regression', version: '1.0.0' },
    },
  });

  const initialized = await readResponse('legacy-initialize');
  assert.equal(initialized.error, undefined, 'legacy initialize must succeed after a modern discover probe');
  assert.equal(initialized.result?.protocolVersion, '2025-11-25');

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 'legacy-tools-list', method: 'tools/list', params: {} });
  const tools = await readResponse('legacy-tools-list');
  assert.equal(tools.error, undefined, 'the fresh legacy instance must serve tools/list');
  assert.ok(Array.isArray(tools.result?.tools));

  console.log('PASS: Desktop Commander creates a fresh, fully configured Server for modern-probe-to-legacy fallback');
} finally {
  lines.close();
  child.kill();
}
