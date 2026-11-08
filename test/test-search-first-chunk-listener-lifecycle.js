import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { SearchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-search-first-chunk-'));
const previous = await configManager.getConfig();
const manager = new SearchManager();

// Provide a controlled stdout after normal search output listeners are wired.
// That makes timeout, first data, and end-of-stream behavior deterministic even
// if ripgrep emits JSON begin/end events for a no-match search.
let scenario = 'timeout';
const originalStartCleanupIfNeeded = manager.startCleanupIfNeeded.bind(manager);
manager.startCleanupIfNeeded = () => {
  originalStartCleanupIfNeeded();
  const newestSession = [...manager.sessions.values()].at(-1);
  if (!newestSession) return;
  const controlledStdout = new PassThrough();
  newestSession.process.stdout = controlledStdout;
  if (scenario === 'data') queueMicrotask(() => controlledStdout.write('first chunk'));
  if (scenario === 'end') queueMicrotask(() => controlledStdout.end());
};

try {
  await fs.writeFile(path.join(rootPath, 'sample.txt'), 'there is no matching phrase here\\n');
  await configManager.setValue('allowedDirectories', [rootPath]);

  for (scenario of ['timeout', 'data', 'end']) {
    const started = await manager.startSearch({
      rootPath,
      pattern: 'not-present-unique-7ca1c3',
      searchType: 'content',
    });
    const session = manager.sessions.get(started.sessionId);
    assert(session?.process.stdout, 'Expected a controlled stdout stream');
    for (const eventName of ['data', 'end', 'close']) {
      assert.equal(
        session.process.stdout.listenerCount(eventName),
        0,
        `${scenario}: temporary ${eventName} listener must be removed`,
      );
    }
  }

  console.log('PASS first-chunk wait releases listeners on timeout, data, and stream end');
} finally {
  await manager.dispose();
  await configManager.setValue('allowedDirectories', previous.allowedDirectories ?? []);
  await fs.rm(rootPath, { recursive: true, force: true });
}
