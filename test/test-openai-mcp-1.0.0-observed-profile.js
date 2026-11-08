import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const client = new Client(
  { name: 'openai-mcp', version: '1.0.0' },
  {
    versionNegotiation: { mode: 'legacy' },
    capabilities: {
      experimental: { 'openai/visibility': { enabled: true } },
      extensions: {
        'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
      },
    },
  },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--no-onboarding'],
  env: {
    ...process.env,
    DC_SDK_V2_EXPERIMENTAL_MRTR: '1',
    DC_SDK_V2_PLAYGROUND: '1',
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
  },
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  assert.equal(tools.length, 32, 'observed ChatGPT capability profile should receive 32 raw server tools');
  assert.equal(names.includes('sdk_v2_multi_round_trip_demo'), false, 'native MRTR must remain hidden without elicitation/2026 protocol');
  for (const name of [
    'sdk_v2_multi_round_trip_demo_app',
    'sdk_v2_chatgpt_capability_lab',
    'sdk_v2_chatgpt_file_param_probe',
  ]) assert(names.includes(name), `${name} should be present in refreshed raw catalog`);

  const appOnly = tools.filter(tool => tool._meta?.ui?.visibility?.includes('app')).map(tool => tool.name).sort();
  assert.deepEqual(appOnly, [
    'get_file_preview_runtime',
    'sdk_v2_chatgpt_capability_lab_echo',
    'sdk_v2_chatgpt_capability_lab_report_v6',
    'sdk_v2_multi_round_trip_demo_app_decide',
  ]);
  const modelVisible = tools.filter(tool => !tool._meta?.ui?.visibility?.includes('app'));
  assert.equal(modelVisible.length, 28, 'OpenAI visibility filtering should leave 28 model-visible tools after a fresh catalog load');
  console.log('PASS observed openai-mcp/1.0.0 profile: raw=32, app-only=4, expected model-visible=28, native MRTR hidden');
} finally {
  await client.close().catch(() => {});
}
