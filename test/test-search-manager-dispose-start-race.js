import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SearchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';

const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-search-dispose-race-'));
const originalConfig = await configManager.getConfig();
const manager = new SearchManager();
const originalWhenStarted = manager.whenStarted.bind(manager);
let signalSpawn;
const spawnReached = new Promise((resolve) => { signalSpawn = resolve; });
let releaseStartup;
const startupGate = new Promise((resolve) => { releaseStartup = resolve; });

try {
  await fs.writeFile(path.join(rootPath, 'large-enough-to-search.txt'), 'needle\n'.repeat(100_000));
  await configManager.setValue('allowedDirectories', [rootPath]);

  // Hold startSearch after the OS spawn event, while dispose() takes ownership
  // of the in-flight child. The original listener is attached immediately so
  // the test cannot miss the spawn event while the gate is closed.
  manager.whenStarted = async (child) => {
    const started = originalWhenStarted(child);
    signalSpawn(child);
    await startupGate;
    await started;
  };

  const starting = manager.startSearch({
    rootPath,
    pattern: 'this-pattern-is-not-present',
    searchType: 'content',
  });

  await spawnReached;
  const disposing = manager.dispose();
  releaseStartup();

  await disposing;
  await assert.rejects(starting, /Search manager is closed/);
  assert.equal(manager.listSearchSessions().length, 0);
  await assert.rejects(
    manager.startSearch({ rootPath, pattern: 'needle', searchType: 'content' }),
    /Search manager is closed/,
  );

  // A stopped Office search may still be inside an uninterruptible filesystem
  // read/parse. dispose() must wait for that in-flight work before resolving.
  const officePath = path.join(rootPath, 'pending.xlsx');
  await fs.writeFile(officePath, '');
  const officeManager = new SearchManager();
  let signalOfficeStart;
  const officeStarted = new Promise((resolve) => { signalOfficeStart = resolve; });
  let releaseOfficeSearch;
  const officeGate = new Promise((resolve) => { releaseOfficeSearch = resolve; });
  officeManager.searchExcelFiles = async () => {
    signalOfficeStart();
    await officeGate;
  };

  try {
    const officeStarting = officeManager.startSearch({
      rootPath: officePath,
      pattern: 'needle',
      searchType: 'content',
    });
    await officeStarted;
    await officeStarting;

    let officeDisposeResolved = false;
    const officeDisposing = officeManager.dispose().then(() => { officeDisposeResolved = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(officeDisposeResolved, false, 'dispose() must await in-flight Office search work');

    releaseOfficeSearch();
    await officeDisposing;
  } finally {
    releaseOfficeSearch();
    await officeManager.dispose();
  }

  console.log('PASS SearchManager.dispose waits for ripgrep startup and in-flight Office work');
} finally {
  releaseStartup();
  await manager.dispose();
  await configManager.setValue('allowedDirectories', originalConfig.allowedDirectories ?? []);
  await fs.rm(rootPath, { recursive: true, force: true });
}
