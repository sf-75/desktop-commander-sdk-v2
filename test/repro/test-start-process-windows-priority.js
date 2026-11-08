import assert from 'assert';
import { constants as osConstants, getPriority, setPriority } from 'os';
import { runIfMain } from '../helpers/run-if-main.js';
import { terminalManager } from '../../dist/terminal-manager.js';

async function testWindowsChildPriorityInheritance() {
  if (process.platform !== 'win32') {
    console.log('⚠️  SKIPPED: Windows process priority inheritance test');
    return;
  }

  const previousSetting = process.env.DC_CHILD_PROCESS_PRIORITY;
  const originalPriority = getPriority(0);

  try {
    // Establish a Normal parent so the test proves both the temporary lowering
    // and the immediate restoration, even when this test itself was launched
    // by a BelowNormal Desktop Commander start_process session.
    setPriority(0, osConstants.priority.PRIORITY_NORMAL);
    const parentBefore = getPriority(0);
    process.env.DC_CHILD_PROCESS_PRIORITY = 'below-normal';

    const result = await terminalManager.executeCommand(
      "Write-Output ((Get-Process -Id $PID).PriorityClass); if ($env:DC_CHILD_PROCESS_PRIORITY) { Write-Output ('LEAK:' + $env:DC_CHILD_PROCESS_PRIORITY) } else { Write-Output 'ENV_CLEAN' }",
      5000,
      'powershell.exe'
    );

    assert(result.pid > 0, 'child shell should start');
    assert.match(result.output, /BelowNormal/i,
      `child shell should inherit BelowNormal, got: ${result.output}`);
    assert.match(result.output, /ENV_CLEAN/,
      `internal priority setting must not leak into child environment: ${result.output}`);
    assert.doesNotMatch(result.output, /LEAK:/,
      `internal priority setting leaked into child environment: ${result.output}`);
    assert.strictEqual(getPriority(0), parentBefore,
      'Desktop Commander process priority must be restored immediately after spawn');

    console.log('✅ Windows child inherited BelowNormal, env stayed clean, and parent priority was restored');
  } finally {
    if (previousSetting === undefined) delete process.env.DC_CHILD_PROCESS_PRIORITY;
    else process.env.DC_CHILD_PROCESS_PRIORITY = previousSetting;
    setPriority(0, originalPriority);
  }
}

async function runAllTests() {
  try {
    await testWindowsChildPriorityInheritance();
    return true;
  } catch (error) {
    console.error('❌ Windows child priority regression test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

runIfMain(import.meta.url, runAllTests);
