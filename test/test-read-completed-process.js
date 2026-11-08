import assert from 'assert';
import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const COMPLETION_TIMEOUT_MS = 10_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCompletion(pid) {
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  while (terminalManager.getSession(pid) && Date.now() < deadline) await sleep(50);
  assert(!terminalManager.getSession(pid), `Process ${pid} should complete within ${COMPLETION_TIMEOUT_MS}ms`);
}

/**
 * Proper test for read_process_output on completed processes
 * 
 * This test should:
 * - FAIL when the bug exists (current behavior)  
 * - PASS when the bug is fixed (desired behavior)
 */
async function testReadCompletedProcessOutput() {
  console.log('Testing read_process_output on completed process...');
  
  // Start echo command with delay, but timeout before echo happens
  const startResult = await startProcess({
    // Cross-platform delay + output using Node
    command: 'node -e "setTimeout(() => console.log(\'SUCCESS MESSAGE\'), 1000)"',
    timeout_ms: 500  // Returns before the output happens
  });
  
  const pid = startResult.structuredContent?.pid;
  assert(pid, 'Should get PID from start_process');
  
  // Wait for the actual command to complete instead of assuming a fixed startup/runtime.
  await waitForCompletion(pid);
  
  // Try to read the output - this should work when fixed
  const readResult = await readProcessOutput({ pid, timeout_ms: 1000 });
  
  // ASSERT: Should be able to read from completed process
  assert(!readResult.isError, 
    'Should be able to read from completed process without error');
    
  // ASSERT: Should contain the echo output
  assert(readResult.content[0].text.includes('SUCCESS MESSAGE'), 
    'Should contain the echo output from completed process');
    
  console.log('✅ Successfully read from completed process');
  console.log('✅ Retrieved echo output:', readResult.content[0].text);
}

/**
 * Test immediate completion scenario
 */
async function testImmediateCompletion() {
  console.log('Testing immediate completion...');
  
  const startResult = await startProcess({
    command: 'node -e "console.log(\'IMMEDIATE OUTPUT\')"',
    timeout_ms: 2000
  });
  
  const pid = startResult.structuredContent?.pid;
  assert(pid, 'Should get PID from start_process');
  
  // Wait for the process to leave the active-session map before reading it.
  await waitForCompletion(pid);
  
  // Should be able to read from immediately completed process
  const readResult = await readProcessOutput({ pid, timeout_ms: 1000 });
  
  assert(!readResult.isError, 
    'Should be able to read from immediately completed process');
    
  assert(readResult.content[0].text.includes('IMMEDIATE OUTPUT'), 
    'Should contain immediate output from completed process');
    
  console.log('✅ Successfully read from immediately completed process');
}

// Run tests
async function runTests() {
  try {
    await testReadCompletedProcessOutput();
    await testImmediateCompletion();
    console.log('\n🎉 All tests passed - read_process_output works on completed processes!');
    return true;
  } catch (error) {
    console.log('\n❌ Test failed:', error.message);
    console.log('\n💡 This indicates the bug still exists:');
    console.log('   read_process_output cannot read from completed processes');
    console.log('   Expected behavior: Should return completion info and final output');
    return false;
  }
}

runIfMain(import.meta.url, runTests);
