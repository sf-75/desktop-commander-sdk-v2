import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const resourceUri = 'ui://desktop-commander/sdk-v2-mrtr-v1';
const notifications = { listChanged: 0, updated: [] };
const client = new Client(
  { name: 'sdk-v2-resource-refresh-test-client', version: '1.0.0' },
  { versionNegotiation: { mode: 'legacy' } },
);
client.setNotificationHandler('notifications/resources/list_changed', () => { notifications.listChanged += 1; });
client.setNotificationHandler('notifications/resources/updated', notification => { notifications.updated.push(notification.params?.uri); });
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
  const opened = await client.callTool({ name: 'sdk_v2_multi_round_trip_demo_app', arguments: {} });
  assert.equal(opened.isError, undefined);
  const deadline = Date.now() + 1500;
  while ((notifications.listChanged < 1 || !notifications.updated.includes(resourceUri)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(notifications.listChanged, 1);
  assert.deepEqual(notifications.updated, [resourceUri]);
  console.log('PASS SDK v2 playground emits resource list_changed + updated notifications from cached MRTR app opener');
} finally {
  await client.close().catch(() => {});
}
