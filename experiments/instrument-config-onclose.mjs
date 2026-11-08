/** Test-only instrumentation: records config watcher disposal on MCP disconnect. */
import fs from 'node:fs';
import { configManager } from '../dist/config-manager.js';
const originalStop = configManager.stopConfigWatcher.bind(configManager);
configManager.stopConfigWatcher = () => {
  // Windows uses fs.watchFile polling; POSIX uses an FSWatcher on the directory.
  const watcherType = configManager.configFilePolling ? 'file-polling'
    : configManager.watcher ? 'directory-watch' : 'none';
  const before = Boolean(configManager.configFilePolling || configManager.watcher);
  originalStop();
  const after = Boolean(configManager.configFilePolling || configManager.watcher);
  const file = process.env.DC_FSWATCH_CLOSE_SENTINEL;
  if (file) fs.appendFileSync(file, JSON.stringify({before,after,watcherType,pid:process.pid})+'\n');
};
