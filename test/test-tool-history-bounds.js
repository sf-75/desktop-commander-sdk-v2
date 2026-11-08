import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const WORKER_FLAG = 'DC_TOOL_HISTORY_BOUNDS_WORKER';

async function worker() {
  const { toolHistory } = await import('../dist/utils/toolHistory.js');
  const oversized = 'x'.repeat(20 * 1024);
  for (let i = 0; i < 1105; i++) {
    toolHistory.addCall('write_file', { path: `file-${i}.txt`, content: oversized }, {
      content: [{ type: 'text', text: 'ok' }],
    });
  }

  const recent = toolHistory.getRecentCalls({ maxResults: 1 })[0];
  assert.equal(typeof recent.arguments, 'string');
  assert.match(recent.arguments, /^\[arguments omitted from history:/);
  assert.ok(!JSON.stringify(recent).includes(oversized));
  const unicodeOutput = 'あ'.repeat(2000);
  toolHistory.addCall('read_file', {}, { content: [{ type: 'text', text: unicodeOutput }] });
  const cappedOutput = toolHistory.getRecentCalls({ maxResults: 1 })[0].output;
  assert.match(cappedOutput.content[0].text, /^\[output omitted from history:/,
    'output cap must measure UTF-8 bytes rather than JavaScript character count');
  assert.equal(toolHistory.getStats().queuedWrites, 1000, 'write queue must retain only its newest 1000 entries');

  await toolHistory.cleanup();
  assert.equal(toolHistory.getStats().queuedWrites, 0, 'cleanup must flush the bounded queue');
  const historyPath = toolHistory.getStats().historyFile;
  const diskText = readFileSync(historyPath, 'utf8');
  assert.ok(!diskText.includes(oversized), 'large request payloads must not be persisted');
  assert.ok(statSync(historyPath).size < 5 * 1024 * 1024);

  // A persistent disk error must not make failed batches grow the retry queue.
  renameSync(historyPath, `${historyPath}.backup`);
  mkdirSync(historyPath); // appendFileSync now fails with EISDIR
  for (let i = 0; i < 1105; i++) {
    toolHistory.addCall('write_file', { path: `failed-${i}.txt`, content: oversized }, {
      content: [{ type: 'text', text: 'ok' }],
    });
  }
  await toolHistory.cleanup();
  assert.equal(toolHistory.getStats().queuedWrites, 1000, 'failed flush retry queue must remain bounded');
  console.log('PASS tool history caps arguments and bounds queued writes, including failed flush retries');
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-tool-history-bounds-'));
  const child = fork(TEST_FILE, [], {
    env: { ...process.env, HOME: home, USERPROFILE: home, [WORKER_FLAG]: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tool history bounds test timed out')), 15_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`worker exited with code ${code}`));
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env[WORKER_FLAG] === '1') await worker();
else await parent();
