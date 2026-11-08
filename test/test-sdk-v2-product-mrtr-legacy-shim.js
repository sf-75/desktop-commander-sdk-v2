import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');

const client = new Client(
  { name: 'sdk-v2-product-mrtr-legacy-test-client', version: '1.0.0' },
  {
    capabilities: { elicitation: {} },
    versionNegotiation: { mode: 'legacy' },
  },
);

let elicitationCalls = 0;
client.setRequestHandler('elicitation/create', async request => {
  elicitationCalls += 1;
  assert.equal(request.params.mode, 'form');
  assert.match(request.params.message, /multi-round-trip demo/i);
  return { action: 'accept', content: { action: 'accept' } };
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--no-onboarding'],
  env: { ...process.env, DC_SDK_V2_EXPERIMENTAL_MRTR: '1', DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === 'sdk_v2_multi_round_trip_demo'));

  const result = await client.callTool({ name: 'sdk_v2_multi_round_trip_demo', arguments: {} });
  assert.equal(elicitationCalls, 1);
  assert.equal(result.isError, undefined);
  assert.match(result.content?.[0]?.text ?? '', /complete: accept/);
  assert.deepEqual(result.structuredContent, {
    status: 'accept',
    proposalId: 'sdk-v2-mrtr-demo',
  });

  console.log('PASS product MRTR legacy shim: 2025-era client with elicitation sees and completes native demo');
} finally {
  await client.close().catch(() => {});
}
