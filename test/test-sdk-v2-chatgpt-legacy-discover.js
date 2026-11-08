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
    DC_SDK_V2_EXPERIMENTAL_MRTR: '1',
    DC_SDK_V2_PLAYGROUND: '1',
    DC_SDK_V2_FORCE_LEGACY_STDIO: '1',
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const lines = readline.createInterface({ input: child.stdout });
const responses = lines[Symbol.asyncIterator]();

async function readJsonLine(timeoutMs = 10_000) {
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

async function readResponse(id, maxMessages = 32) {
  for (let i = 0; i < maxMessages; i += 1) {
    const message = await readJsonLine();
    if (message.id === id) return message;
  }
  throw new Error(`timed out waiting for JSON-RPC response id ${id}`);
}

try {
  await new Promise(resolve => setTimeout(resolve, 800));

  send({
    jsonrpc: '2.0',
    id: 'openai-mcp-discover',
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2025-11-25',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });

  const discover = await readResponse('openai-mcp-discover');
  assert.equal(discover.id, 'openai-mcp-discover');
  assert.equal(discover.error?.code, -32601, 'legacy entrypoint should let ChatGPT fall back from pre-init server/discover');
  assert.notEqual(discover.error?.code, -32022, 'ChatGPT 2025 discover must not be rejected as a modern-only revision');

  send({
    jsonrpc: '2.0',
    id: 'initialize',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'openai-mcp', version: '1.0.0' },
    },
  });

  const initialized = await readResponse('initialize');
  assert.equal(initialized.id, 'initialize');
  assert.equal(initialized.error, undefined, '2025 fallback initialize must succeed after server/discover');
  assert.equal(initialized.result?.protocolVersion, '2025-11-25');

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  send({ jsonrpc: '2.0', id: 'tools-list', method: 'tools/list', params: {} });

  const tools = await readResponse('tools-list');
  assert.equal(tools.id, 'tools-list');
  assert.equal(tools.error, undefined, 'tools/list must succeed on the same fallback connection');
  assert.ok(Array.isArray(tools.result?.tools));
  assert.ok(
    tools.result.tools.some(tool => tool.name === 'sdk_v2_multi_round_trip_demo_app'),
    '2025 fallback connection should expose the MRTR App fallback',
  );
  assert.equal(
    tools.result.tools.some(tool => tool.name === 'sdk_v2_multi_round_trip_demo'),
    false,
    '2025 client without elicitation must not see the native 2026 MRTR demo',
  );

  console.log('PASS ChatGPT transitional 2025 server/discover falls back, initializes, and lists the legacy MRTR App surface');
} finally {
  lines.close();
  child.kill();
}
