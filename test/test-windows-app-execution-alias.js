import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { resolveShellPath, isShellAvailable } from '../dist/utils/shell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

export default async function runTests() {
  if (process.platform !== 'win32') {
    skip('Windows App Execution Alias test: Windows only');
    return true;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    skip('Windows App Execution Alias test: LOCALAPPDATA is unavailable');
    return true;
  }
  const dir = path.join(localAppData, 'Microsoft', 'WindowsApps');
  let entries;
  try {
    entries = fs.readdirSync(dir).map((entry) => entry.toLowerCase());
  } catch {
    skip('Windows App Execution Alias test: WindowsApps cannot be listed');
    return true;
  }
  if (!entries.includes('pwsh.exe')) {
    skip('Windows App Execution Alias test: Store/AppX pwsh.exe is not installed');
    return true;
  }

  const pwsh = path.join(dir, 'pwsh.exe');
  assert.strictEqual(resolveShellPath('pwsh')?.toLowerCase(), pwsh.toLowerCase());
  assert.strictEqual(isShellAvailable('pwsh'), true);
  assert.strictEqual(resolveShellPath('dc-no-such-app-alias'), null);
  if (entries.includes('bash.exe')) {
    const windowsAppsBash = path.join(dir, 'bash.exe');
    assert.strictEqual(resolveShellPath(windowsAppsBash), null, 'WindowsApps WSL bash launcher should not be treated as a usable shell');
    assert.notStrictEqual(resolveShellPath('bash')?.toLowerCase(), windowsAppsBash.toLowerCase());
  }
  const systemRoot = process.env.SystemRoot;
  if (systemRoot) {
    const systemBash = path.join(systemRoot, 'System32', 'bash.exe');
    if (fs.existsSync(systemBash)) {
      assert.strictEqual(resolveShellPath(systemBash), null, 'System32 WSL bash launcher should not be treated as a usable shell');
    }
  }
  console.log('✓ Store/AppX pwsh App Execution Alias is discoverable without admitting nonexistent aliases or WSL bash launchers');
  return true;
}

runIfMain(import.meta.url, runTests);
