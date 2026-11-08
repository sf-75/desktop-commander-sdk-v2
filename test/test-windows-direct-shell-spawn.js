import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getShellSpawnArgs, resolveShellPath } from '../dist/utils/shell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

async function runTests() {
  if (process.platform !== 'win32') return skip('Windows-only direct shell spawn regression');

  const powershell = resolveShellPath('powershell.exe');
  if (!powershell) return skip('powershell.exe is not available');

  const direct = getShellSpawnArgs('powershell.exe', 'powershell -NoProfile -NoLogo');
  assert.deepEqual(direct.args, ['-NoProfile', '-NoLogo']);
  assert.equal(direct.useShellOption, false);

  const directExe = getShellSpawnArgs('powershell.exe', 'powershell.exe -NoProfile');
  assert.deepEqual(directExe.args, ['-NoProfile']);

  const directResolvedPath = getShellSpawnArgs('powershell.exe', `${powershell} -NoLogo`);
  assert.deepEqual(directResolvedPath.args, ['-NoLogo']);

  const quoted = getShellSpawnArgs('powershell.exe', 'powershell -Command "Write-Output hello"');
  assert.deepEqual(quoted.args, ['-Command', 'powershell -Command "Write-Output hello"']);

  const metachar = getShellSpawnArgs('powershell.exe', 'powershell; Write-Output hello');
  assert.deepEqual(metachar.args, ['-Command', 'powershell; Write-Output hello']);

  const multiline = getShellSpawnArgs('powershell.exe', 'powershell\n-NoProfile');
  assert.deepEqual(multiline.args, ['-Command', 'powershell\n-NoProfile']);

  const multilineCrLf = getShellSpawnArgs('powershell.exe', 'powershell\r\n-NoLogo');
  assert.deepEqual(multilineCrLf.args, ['-Command', 'powershell\r\n-NoLogo']);

  const otherShell = getShellSpawnArgs('powershell.exe', 'cmd /Q');
  assert.deepEqual(otherShell.args, ['-Command', 'cmd /Q']);

  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc443-shell-'));
  const fakePowerShell = path.join(fakeDir, 'powershell.exe');
  try {
    await fs.writeFile(fakePowerShell, 'not-an-executable');
    const alternatePath = getShellSpawnArgs('powershell.exe', `${fakePowerShell} -NoProfile`);
    assert.deepEqual(alternatePath.args, ['-Command', `${fakePowerShell} -NoProfile`],
      'a different same-basename executable must not be replaced by the configured shell');
  } finally {
    await fs.rm(fakeDir, { recursive: true, force: true });
  }

  const cmd = resolveShellPath('cmd.exe');
  if (cmd) {
    const directCmd = getShellSpawnArgs('cmd.exe', 'cmd /Q');
    assert.deepEqual(directCmd.args, ['/Q']);
    assert.equal(directCmd.windowsVerbatim, true);
  }

  console.log('PASS: simple same-shell invocations are direct while ambiguous commands preserve wrapper behavior');
  return true;
}

runIfMain(import.meta.url, runTests);
