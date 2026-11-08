import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');

const client = new Client(
  { name: 'sdk-v2-mrtr-default-off-test-client', version: '1.0.0' },
  { capabilities: {} },
);

const env = {
  ...process.env,
  DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
};
delete env.DC_SDK_V2_EXPERIMENTAL_MRTR;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--no-onboarding'],
  env,
  stderr: 'pipe',
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 26, 'default contract must remain 26 tools');
  assert.equal(
    tools.tools.some(tool => tool.name.includes('sdk_v2_multi_round_trip')),
    false,
    'experimental MRTR tools must remain hidden by default',
  );

  const resources = await client.listResources();
  assert.equal(resources.resources.length, 2, 'default contract must remain 2 resources');
  assert.equal(
    resources.resources.some(resource => resource.uri.includes('sdk-v2-mrtr')),
    false,
    'experimental MRTR resource must remain hidden by default',
  );

  console.log('PASS sdk v2 MRTR default-off contract: 26 tools / 2 resources and no experimental exposure');
} finally {
  await client.close().catch(() => {});
}
