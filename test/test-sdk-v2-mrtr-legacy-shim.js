import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, 'fixtures', 'sdk-v2-mrtr-server.js');

const client = new Client(
  { name: 'sdk-v2-mrtr-legacy-shim-test-client', version: '1.0.0' },
  {
    capabilities: { elicitation: {} },
    versionNegotiation: { mode: 'legacy' },
  },
);

let elicitationCalls = 0;
client.setRequestHandler('elicitation/create', async request => {
  elicitationCalls += 1;
  assert.equal(request.params.mode, 'form');
  assert.equal(request.params.message, 'この提案を承認しますか？');
  return {
    action: 'accept',
    content: { action: 'accept' },
  };
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: 'pipe',
});

let stderr = '';
transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });

try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'mrtr_probe', arguments: {} });

  assert.equal(elicitationCalls, 1, 'legacy shim should elicit exactly once');
  assert.equal(result.content?.[0]?.type, 'text');
  assert.equal(result.content?.[0]?.text, 'mrtr complete: accept');
  assert.deepEqual(result.structuredContent, {
    status: 'accept',
    proposalId: 'fixture-proposal-1',
  });
  assert.match(stderr, /MRTR_INITIAL_STATE=true/);
  assert.match(stderr, /MRTR_REENTRY_STATE=.*fixture-proposal-1/);
  assert.match(stderr, /MRTR_RESPONSE=accept/);

  console.log('PASS sdk v2 MRTR legacy shim: 2025-era elicitation -> handler re-entry with verified requestState');
} finally {
  await client.close().catch(() => {});
}
