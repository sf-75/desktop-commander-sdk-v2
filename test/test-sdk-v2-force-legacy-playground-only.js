import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'dist', 'index.js');
const env = {
  ...process.env,
  DC_SDK_V2_EXPERIMENTAL_MRTR: '1',
  DC_SDK_V2_FORCE_LEGACY_STDIO: '1',
  DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
};
delete env.DC_SDK_V2_PLAYGROUND;

const child = spawn(process.execPath, [serverPath, '--no-onboarding'], {
  cwd: path.join(here, '..'),
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lines = readline.createInterface({ input: child.stdout });
const responses = lines[Symbol.asyncIterator]();

async function readResponse(id, timeoutMs = 10_000) {
  for (let i = 0; i < 32; i += 1) {
    let timer;
    try {
      const result = await Promise.race([
        responses.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out waiting for JSON-RPC response id ${id}`)), timeoutMs);
        }),
      ]);
      if (result.done) throw new Error('server stdout closed before JSON-RPC response');
      const message = JSON.parse(result.value);
      if (message.id === id) return message;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`too many messages while waiting for JSON-RPC response id ${id}`);
}

try {
  await new Promise(resolve => setTimeout(resolve, 800));
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 'modern-discover',
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'dc-sdk-v2-force-scope-probe', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }) + '\n');

  const response = await readResponse('modern-discover');
  assert.equal(response.error, undefined, 'FORCE_LEGACY_STDIO must be ignored outside the Playground');
  assert.ok(response.result?.supportedVersions?.includes('2026-07-28'));
  console.log('PASS FORCE_LEGACY_STDIO is scoped to the SDK v2 Playground');
} finally {
  lines.close();
  child.kill();
}
