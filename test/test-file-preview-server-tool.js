import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const serverFile = resolve(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverFile], stderr: 'pipe' });
  const client = new Client({ name: 'desktop-commander-app', version: '1.0.0' }, { capabilities: {} });
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('MCP viewer integration timed out')), 30000);
  });
  try {
    await Promise.race([client.connect(transport), limit]);
    const listing = await Promise.race([client.listTools(), limit]);
    const tool = listing.tools.find(t => t.name === 'get_file_preview_runtime');
    assert.ok(tool, 'App-only viewer runtime must be registered');
    assert.deepEqual(tool._meta?.ui?.visibility, ['app']);
    assert.equal(tool._meta?.ui?.resourceUri, undefined, 'App-only runtime tool must not advertise its own widget');
    assert.equal(tool._meta?.['openai/widgetAccessible'], undefined, 'App-only runtime tool must not use ChatGPT widget metadata');
    const response = await Promise.race([
      client.callTool({ name: 'get_file_preview_runtime', arguments: { origin: 'ui' } }),
      limit
    ]);
    assert.equal(response.isError, undefined, 'UI must retrieve viewer successfully');
    const encoded = response.content.find(x => x.type === 'text')?.text;
    assert.ok(encoded && encoded.length > 10000, 'Viewer must be nonempty');
    const js = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
    assert.ok(js.includes('__dcStartFilePreview'), 'Payload must expose viewer entrypoint');
    console.log('PASS: real MCP runtime delivery, gzip content, app-only metadata');
    return true;
  } finally {
    clearTimeout(timer);
    try { await client.close(); } catch { /* transport already gone */ }
  }
}
runIfMain(import.meta.url, runTests);
