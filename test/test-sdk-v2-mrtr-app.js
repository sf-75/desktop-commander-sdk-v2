import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const resourceUri = 'ui://desktop-commander/sdk-v2-mrtr-v1';
const client = new Client(
  { name: 'sdk-v2-mrtr-app-test-client', version: '1.0.0' },
  { versionNegotiation: { mode: 'legacy' } },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, '--no-onboarding'],
  env: {
    ...process.env,
    DC_SDK_V2_EXPERIMENTAL_MRTR: '1',
    DC_SDK_V2_PLAYGROUND: '0',
    DC_SDK_V2_FORCE_LEGACY_STDIO: '0',
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
    DC_FLAG_URL: 'http://127.0.0.1:9/',
  },
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const resources = await client.listResources();
  assert(resources.resources.some(resource => resource.uri === resourceUri));
  const resource = await client.readResource({ uri: resourceUri });
  const html = resource.contents?.[0]?.text ?? '';
  assert.match(html, /mrtr-title/);
  assert.match(html, /mrtr-accept/);
  assert.match(html, /mrtr-decline/);
  assert.doesNotMatch(html, /src=["']\.\/sdk-v2-mrtr-runtime\.js/);
  assert.doesNotMatch(html, /href=["']\.\/styles\.css/);

  const tools = await client.listTools();
  assert.equal(tools.tools.some(tool => tool.name === 'sdk_v2_multi_round_trip_demo'), false);
  const opener = tools.tools.find(tool => tool.name === 'sdk_v2_multi_round_trip_demo_app');
  assert(opener);
  assert.equal(opener._meta?.['openai/outputTemplate'], resourceUri);
  assert.equal(opener._meta?.ui?.resourceUri, resourceUri);
  assert.equal(opener._meta?.['openai/widgetAccessible'], true);
  const decisionTool = tools.tools.find(tool => tool.name === 'sdk_v2_multi_round_trip_demo_app_decide');
  assert(decisionTool);
  assert.deepEqual(decisionTool._meta?.ui?.visibility, ['app']);

  const opened = await client.callTool({
    name: 'sdk_v2_multi_round_trip_demo_app',
    arguments: {
      prompt: 'Approve editing sample data?',
      detail: 'Target: sample.xlsx / Sheet1!A1',
      acceptLabel: 'Yes',
      declineLabel: 'No',
      proposalId: 'excel-edit-probe',
    },
  });
  assert.equal(opened.isError, undefined);
  assert.equal(opened.structuredContent?.status, 'pending');
  assert.equal(opened.structuredContent?.proposalId, 'excel-edit-probe');
  assert.equal(opened.structuredContent?.prompt, 'Approve editing sample data?');
  assert.equal(opened.structuredContent?.detail, 'Target: sample.xlsx / Sheet1!A1');
  assert.deepEqual(opened.structuredContent?.choices, [
    { id: 'accept', label: 'Yes' },
    { id: 'decline', label: 'No' },
  ]);
  assert.match(opened.content?.[0]?.text ?? '', /App UI/);

  const accepted = await client.callTool({
    name: 'sdk_v2_multi_round_trip_demo_app_decide',
    arguments: { origin: 'ui', action: 'accept', proposalId: 'excel-edit-probe' },
  });
  assert.equal(accepted.isError, undefined);
  assert.equal(accepted.structuredContent?.status, 'accept');
  assert.equal(accepted.structuredContent?.proposalId, 'excel-edit-probe');
  assert.match(accepted.content?.[0]?.text ?? '', /complete: accept/);

  // Schema limits and runtime validation should agree. Character-count boundaries.
  const limits = [
    ['prompt', 500],
    ['detail', 2000],
    ['acceptLabel', 80],
    ['declineLabel', 80],
    ['proposalId', 120],
  ];
  const opSchema = opener.inputSchema?.properties ?? {};
  for (const [field, maxLength] of limits) {
    assert.equal(opSchema[field]?.type, 'string');
    assert.equal(opSchema[field]?.maxLength, maxLength);
    const withinLimit = await client.callTool({
      name: 'sdk_v2_multi_round_trip_demo_app',
      arguments: { [field]: 'a'.repeat(maxLength) },
    });
    assert.notEqual(withinLimit.isError, true, field + ' must accept maxLength');
    const overLimit = await client.callTool({
      name: 'sdk_v2_multi_round_trip_demo_app',
      arguments: { [field]: 'a'.repeat(maxLength + 1) },
    });
    assert.equal(overLimit.isError, true, field + ' must reject maxLength + 1');
  }

  for (const args of [
    { prompt: 42 },
    { detail: null },
    { unknownField: 'extra' },
    { constructor: 'unexpected inherited property' },
    { prompt: '😀'.repeat(500) + 'a' },
  ]) {
    const invalid = await client.callTool({
      name: 'sdk_v2_multi_round_trip_demo_app',
      arguments: args,
    });
    assert.equal(invalid.isError, true, 'Invalid opener argument should fail: ' + JSON.stringify(args).slice(0, 80));
  }
  const astralUnicode = await client.callTool({
    name: 'sdk_v2_multi_round_trip_demo_app',
    arguments: { prompt: '😀'.repeat(500) },
  });
  assert.notEqual(astralUnicode.isError, true, '500 Unicode code points must pass');

  for (const args of [
    { origin: 'ui', action: 'accept', proposalId: 'a'.repeat(121) },
    { origin: 'ui', action: 'decline', proposalId: 1 },
    { origin: 'ui', action: 'accept', unknownField: 'extra' },
  ]) {
    const invalid = await client.callTool({
      name: 'sdk_v2_multi_round_trip_demo_app_decide',
      arguments: args,
    });
    assert.equal(invalid.isError, true, 'Invalid decision argument should fail');
  }

  const modelAttempt = await client.callTool({
    name: 'sdk_v2_multi_round_trip_demo_app_decide',
    arguments: { action: 'decline' },
  });
  assert.equal(modelAttempt.isError, true);
  assert.match(modelAttempt.content?.[0]?.text ?? '', /UI-only operation/);
  console.log('PASS SDK v2 MRTR App: custom labels, fallback, proposal ID, UI-only decision');
} finally {
  await client.close().catch(() => {});
}
