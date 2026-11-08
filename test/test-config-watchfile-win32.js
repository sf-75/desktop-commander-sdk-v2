/**
 * Windows config polling regression: directory replacement must not leave a
 * native fs_event watcher, and config reload must survive atomic replacement.
 * The standard test runner supplies a disposable dc-test-home-* USERPROFILE.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isTestHome } from './helpers/test-env.js';

if (process.platform !== 'win32') {
  console.log('SKIP Windows-only config watchFile integration');
} else {
  assert(isTestHome(), 'Refuse to test config mutation outside disposable test home');
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';
  const configDir = path.join(os.homedir(), '.claude-server-commander');
  const configPath = path.join(configDir, 'config.json');
  const seed = (marker) => JSON.stringify({
    telemetryEnabled: false,
    welcomeOnboardingEligible: false,
    pendingWelcomeOnboarding: false,
    fswatchProbe: marker,
  });
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, seed('startup'), 'utf8');
  const { configManager } = await import('../dist/config-manager.js');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const observed = async (expected, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await configManager.getValue('fswatchProbe') === expected) return;
      await sleep(80);
    }
    assert.equal(await configManager.getValue('fswatchProbe'), expected,
      `Timed out waiting for config change to ${expected}`);
  };
  const startTime = Date.now();
  let reloadCount = 0;
  const originalReload = configManager.reloadConfigFromDisk.bind(configManager);
  configManager.reloadConfigFromDisk = async (...args) => {
    reloadCount++;
    return originalReload(...args);
  };
  try {
    assert.equal(await configManager.getValue('fswatchProbe'), 'startup');
    assert.equal(configManager.watcher, null, 'Windows must not use directory fs.watch');
    assert.equal(configManager.configFilePolling, true, 'ConfigManager must use fs.watchFile');
    configManager.startConfigWatcher();
    configManager.startConfigWatcher();
    assert.equal(configManager.configFilePolling, true, 'watch registration is idempotent');

    await fs.writeFile(configPath, seed('external-write'), 'utf8');
    await observed('external-write');

    const atomicTemp = path.join(configDir, 'config-atomic-new.json');
    await fs.writeFile(atomicTemp, seed('atomic-rename'), 'utf8');
    await fs.rename(atomicTemp, configPath);
    await observed('atomic-rename');

    const beforeBurstReloads = reloadCount;
    await fs.writeFile(configPath, seed('burst-1'), 'utf8');
    await fs.writeFile(configPath, seed('burst-2'), 'utf8');
    await fs.writeFile(configPath, seed('burst-3'), 'utf8');
    await observed('burst-3');
    await sleep(200);
    assert.equal(reloadCount - beforeBurstReloads, 1,
      'Rapid consecutive changes should coalesce to one reload');

    // Wait until the watcher actually observed the missing file. If the parent
    // were recreated immediately, a 2s poll might miss the deleted state.
    await fs.rm(configDir, { recursive: true, force: true });
    await sleep(2600);
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, seed('directory-restored'), 'utf8');
    await observed('directory-restored', 9000);

    // Explicit stop must remove the single registered poll callback.
    configManager.stopConfigWatcher();
    configManager.stopConfigWatcher();
    assert.equal(configManager.configFilePolling, false);
    await fs.writeFile(configPath, seed('not-observed-after-stop'), 'utf8');
    await sleep(2500);
    assert.equal(await configManager.getValue('fswatchProbe'), 'directory-restored',
      'Stopped watcher must not reload config');

    // An explicitly restarted watcher should work with the same config file.
    configManager.startConfigWatcher();
    assert.equal(configManager.configFilePolling, true);
    await fs.writeFile(configPath, seed('restart-ok'), 'utf8');
    await observed('restart-ok', 9000);
    assert(reloadCount >= 4, `Expected multiple config reloads, got ${reloadCount}`);

    console.log(`PASS Windows config watchFile: external, atomic, burst, delete/recreate, stop/restart; reloads=${reloadCount}, elapsedMs=${Date.now() - startTime}`);
  } finally {
    configManager.stopConfigWatcher();
  }
}
