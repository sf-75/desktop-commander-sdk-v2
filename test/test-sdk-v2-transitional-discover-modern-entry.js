import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const env = { ...process.env };
delete env.DC_SDK_V2_FORCE_LEGACY_STDIO;
Object.assign(env, {
  DC_SDK_V2_EXPERIMENTAL_MRTR: '1',
  DC_SDK_V2_PLAYGROUND: '1',
  DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
});

const child = spawn(process.execPath, [serverPath, '--no-onboarding'], {
  cwd: path.join(here, '..'),
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout });
const responses = lines[Symbol.asyncIterator]();

async function readJsonLine(timeoutMs = 10_000) {
  let timer;
  try {
    const result = await Promise.race([
      responses.next(),
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

async function readResponse(id, maxMessages = 64) {
  for (let index = 0; index < maxMessages; index += 1) {
    const message = await readJsonLine();
    if (message.id === id) return message;
  }
  throw new Error(`timed out waiting for JSON-RPC response id ${id}`);
}

try {
  await new Promise(resolve => setTimeout(resolve, 800));
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 'openai-modern-entry-discover',
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2025-11-25',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }) + '\n');

  const response = await readResponse('openai-modern-entry-discover');
  assert.equal(response.id, 'openai-modern-entry-discover');
  assert.equal(
    response.error?.code,
    -32601,
    `normal experimental SDK v2 entrypoint must permit ChatGPT's transitional 2025 server/discover fallback; got ${JSON.stringify(response.error ?? response.result)}`,
  );

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 'initialize-after-transitional-discover',
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'openai-mcp', version: '1.0.0' },
    },
  }) + '\n');
  const initialized = await readResponse('initialize-after-transitional-discover');
  assert.equal(initialized.id, 'initialize-after-transitional-discover');
  assert.equal(initialized.error, undefined, 'legacy initialize must succeed after the transitional discover probe');
  assert.equal(initialized.result?.protocolVersion, '2025-11-25');

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }) + '\n');
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 'tools-after-transitional-discover',
    method: 'tools/list',
    params: {},
  }) + '\n');
  const tools = await readResponse('tools-after-transitional-discover');
  assert.equal(tools.id, 'tools-after-transitional-discover');
  assert.equal(tools.error, undefined, 'tools/list must succeed on the fallback connection');
  assert.ok(tools.result?.tools?.some(tool => tool.name === 'sdk_v2_multi_round_trip_demo_app'));
  assert.equal(
    tools.result?.tools?.some(tool => tool.name === 'sdk_v2_multi_round_trip_demo'),
    false,
    '2025 fallback must not expose the native 2026 MRTR tool',
  );
  console.log('PASS transitional 2025 discover is gracefully handed off; initialize and legacy MRTR App listing succeed on the same connection');
} finally {
  lines.close();
  child.kill();
}
