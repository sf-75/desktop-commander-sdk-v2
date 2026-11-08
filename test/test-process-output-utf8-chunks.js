/**
 * Regression tests for UTF-8 sequences split across stdout/stderr chunks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const EXPECTED = String.fromCodePoint(0x2264);
const REPLACEMENT = '\uFFFD';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOne(streamName, root) {
  const scriptPath = path.join(root, `${streamName}.cjs`);
  fs.writeFileSync(scriptPath, `
const stream = process.${streamName};
stream.write(Buffer.from([0xE2]));
setTimeout(() => stream.write(Buffer.from([0x89])), 60);
setTimeout(() => stream.write(Buffer.from([0xA4])), 120);
setTimeout(() => stream.write(Buffer.from('\\n')), 180);
setTimeout(() => process.exit(0), 240);
`);

  const started = await terminalManager.executeCommand(`node "${scriptPath}"`, 5000);
  assert.ok(started.pid > 0, `${streamName} child should start: ${started.output}`);
  let combined = started.output;
  for (let attempt = 0; attempt < 100 && !combined.includes(EXPECTED); attempt++) {
    await sleep(50);
    const page = terminalManager.readOutputPaginated(started.pid, 0, 100);
    combined = `${started.output}\\n${page?.lines?.join('\\n') ?? ''}`;
  }

  assert.ok(combined.includes(EXPECTED), `${streamName} should preserve split UTF-8: ${JSON.stringify(combined)}`);
  assert.ok(!combined.includes(REPLACEMENT), `${streamName} should not contain replacement characters: ${JSON.stringify(combined)}`);
  console.log(`PASS: ${streamName} preserves split UTF-8`);
}

async function runTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-utf8-process-output-'));
  try {
    await runOne('stdout', root);
    await runOne('stderr', root);
    console.log('PASS: process output decodes UTF-8 across chunk boundaries');
    return true;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

runIfMain(import.meta.url, runTests);
