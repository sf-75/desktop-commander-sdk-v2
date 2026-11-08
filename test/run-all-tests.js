/**
 * Main test runner script
 * Runs all test modules and provides comprehensive summary
 */

import { execFile, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { createTestEnv } from './helpers/test-env.js';

// Get directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const GiB = 1024 ** 3;
const throttleConfig = {
  enabled: process.env.DC_TEST_THROTTLE !== '0',
  maxCpuPct: Number(process.env.DC_TEST_MAX_CPU_PCT ?? 70),
  minFreeRamGB: Number(process.env.DC_TEST_MIN_FREE_RAM_GB ?? Math.max(8, os.totalmem() / GiB * 0.18).toFixed(1)),
  cpuSampleMs: Number(process.env.DC_TEST_CPU_SAMPLE_MS ?? 300),
  pollMs: Number(process.env.DC_TEST_THROTTLE_POLL_MS ?? 1500),
  maxWaitMs: Number(process.env.DC_TEST_CAPACITY_MAX_WAIT_MS ?? 0), // 0 preserves unlimited local waiting
  normalCooldownMs: Number(process.env.DC_TEST_COOLDOWN_MS ?? 250),
  browserCooldownMs: Number(process.env.DC_TEST_BROWSER_COOLDOWN_MS ?? 2500),
  chromeExtraCount: Number(process.env.DC_TEST_MAX_EXTRA_CHROME ?? 24),
  chromeExtraGB: Number(process.env.DC_TEST_MAX_EXTRA_CHROME_GB ?? 4),
};

function isBrowserHeavyTest(testFile) {
  return /html-preview|pdf-(?:creation|launch|render|chrome|system)|file-handlers/i.test(testFile);
}

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

async function sampleCpuPct() {
  const before = cpuSnapshot();
  await sleep(throttleConfig.cpuSampleMs);
  const after = cpuSnapshot();
  const idle = after.idle - before.idle;
  const total = after.total - before.total;
  return total > 0 ? 100 * (1 - idle / total) : 0;
}

function readWindowsChromePressure() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script = [
    "$dcChrome=@(Get-Process chrome -ErrorAction SilentlyContinue)",
    "$dcWs=(($dcChrome | Measure-Object WorkingSet64 -Sum).Sum)",
    "Write-Output (('{0}|{1}' -f $dcChrome.Count,[int64]$dcWs))"
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const [countText, wsText] = stdout.trim().split('|');
      const count = Number(countText);
      const workingSetBytes = Number(wsText);
      resolve(Number.isFinite(count) && Number.isFinite(workingSetBytes) ? { count, workingSetBytes } : null);
    });
  });
}

async function waitForSystemCapacity(testFile, chromeBaseline) {
  if (!throttleConfig.enabled) return;
  const browserHeavy = isBrowserHeavyTest(testFile);
  let waitedMs = 0;
  let throttled = false;
  let safeSamples = 0;

  while (true) {
    const cpuPct = await sampleCpuPct();
    const freeRamGB = os.freemem() / GiB;
    const chrome = browserHeavy ? await readWindowsChromePressure() : null;
    const chromeCountOk = !chrome || !chromeBaseline || chrome.count <= chromeBaseline.count + throttleConfig.chromeExtraCount;
    const chromeRamOk = !chrome || !chromeBaseline || chrome.workingSetBytes <= chromeBaseline.workingSetBytes + throttleConfig.chromeExtraGB * GiB;
    const safe = cpuPct <= throttleConfig.maxCpuPct && freeRamGB >= throttleConfig.minFreeRamGB && chromeCountOk && chromeRamOk;

    if (safe) {
      if (!throttled) break;
      safeSamples++;
      if (safeSamples >= 2) break;
    } else {
      throttled = true;
      safeSamples = 0;
      const chromeText = chrome && chromeBaseline
        ? `, Chrome ${chrome.count} proc / ${(chrome.workingSetBytes / GiB).toFixed(1)}GB (baseline ${chromeBaseline.count} / ${(chromeBaseline.workingSetBytes / GiB).toFixed(1)}GB)`
        : '';
      console.log(`${colors.yellow}⏳ Throttling before ${testFile}: CPU ${cpuPct.toFixed(1)}%, free RAM ${freeRamGB.toFixed(1)}GB${chromeText}${colors.reset}`);
    }

    await sleep(throttleConfig.pollMs);
    waitedMs += throttleConfig.pollMs + throttleConfig.cpuSampleMs;
    if (throttleConfig.maxWaitMs > 0 && waitedMs >= throttleConfig.maxWaitMs) {
      const error = new Error(`NOT RUN: capacity gate could not clear for ${testFile} after ${(waitedMs / 1000).toFixed(1)}s (CPU <= ${throttleConfig.maxCpuPct}%, free RAM >= ${throttleConfig.minFreeRamGB}GiB required)`);
      error.code = 'CAPACITY_NOT_RUN';
      throw error;
    }
  }

  if (waitedMs > 0) {
    console.log(`${colors.green}✓ Load gate cleared for ${testFile} after ${(waitedMs / 1000).toFixed(1)}s${colors.reset}`);
  }
}

async function coolDownAfterTest(testFile) {
  if (!throttleConfig.enabled) return;
  await sleep(isBrowserHeavyTest(testFile) ? throttleConfig.browserCooldownMs : throttleConfig.normalCooldownMs);
}

/**
 * Run a command and return its output
 */
function runCommand(command, args, cwd = __dirname) {
  return new Promise((resolve, reject) => {
    const commandLine = [command, ...args].join(' ');
    console.log(`${colors.blue}Running command: ${commandLine}${colors.reset}`);

    // One command string: with shell: true, Node 24 deprecates separate args (DEP0190)
    const proc = spawn(commandLine, {
      cwd,
      stdio: 'inherit',
      shell: true
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/** Remove a test home, giving delayed Windows grandchildren one extra chance to release it. */
async function cleanupTestEnv(testEnv) {
  try {
    testEnv.cleanup();
    return null;
  } catch (firstError) {
    // createTestEnv.cleanup() already retries transient removal failures. Only pay
    // this extra grace period when those retries were not enough.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    try {
      testEnv.cleanup();
      return null;
    } catch (error) {
      console.warn(`${colors.yellow}⚠️  Could not remove test home ${testEnv.home}: ${error.message} (first failure: ${firstError.message})${colors.reset}`);
      return error;
    }
  }
}

/**
 * Run a single Node.js test file as a subprocess
 */
function runTestFile(testFile) {
  return new Promise((resolve) => {
    console.log(`\n${colors.cyan}Running test module: ${testFile}${colors.reset}`);
    
    const startTime = Date.now();
    // Tests record skipped checks here (see skip() in helpers/run-if-main.js)
    const skipFile = path.join(os.tmpdir(), `dc-test-skips-${process.pid}-${path.basename(testFile)}.txt`);
    // Every test file gets its own temporary home, so none can touch the real config
    const testEnv = createTestEnv();
    let cleanupPromise;
    const cleanupOnce = () => cleanupPromise ??= cleanupTestEnv(testEnv);
    const proc = spawn('node', [testFile], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: false,
      env: { ...testEnv.env, DC_TEST_SKIP_FILE: skipFile }
    });

    proc.on('close', async (code) => {
      const cleanupError = await cleanupOnce();
      const duration = Date.now() - startTime;
      const skipped = await fs.readFile(skipFile, 'utf8')
        .then((text) => text.split('\n').filter(Boolean), () => []);
      await fs.rm(skipFile, { force: true });
      if (code === 0 && !cleanupError) {
        console.log(`${colors.green}✓ Test passed: ${testFile} (${duration}ms)${colors.reset}`);
        if (skipped.length > 0) {
          console.log(`${colors.yellow}⚠️  ${skipped.length} check(s) skipped in ${testFile}${colors.reset}`);
        }
        resolve({ success: true, file: testFile, duration, exitCode: code, skipped });
      } else {
        const cleanupSuffix = cleanupError ? `; test-home cleanup failed: ${cleanupError.message}` : '';
        console.error(`${colors.red}✗ Test failed: ${testFile} (${duration}ms) - Exit code: ${code}${cleanupSuffix}${colors.reset}`);
        resolve({ success: false, file: testFile, duration, exitCode: code, skipped, ...(cleanupError ? { error: cleanupError.message } : {}) });
      }
    });
    
    proc.on('error', async (err) => {
      await cleanupOnce();
      const duration = Date.now() - startTime;
      console.error(`${colors.red}✗ Error running ${testFile}: ${err.message}${colors.reset}`);
      resolve({ success: false, file: testFile, duration, error: err.message });
    });
  });
}

/**
 * Build the project
 */
async function buildProject() {
  console.log(`\n${colors.cyan}===== Building project =====${colors.reset}\n`);
  await runCommand('npm', ['run', 'build']);
}

/**
 * Discover and run all test modules
 */
async function runTestModules() {
  console.log(`\n${colors.cyan}===== Running tests =====${colors.reset}\n`);
  
  // Discover all test files
  let testFiles = [];
  try {
    const files = await fs.readdir(__dirname);

    // The files named on the command line (`node test/run-all-tests.js test-x.js`),
    // so one test can run isolated too; else all files starting with 'test' and ending with '.js'
    const requested = process.argv.slice(2).map(file => path.basename(file));
    const discoveredTests = requested.length > 0
      ? requested
      : files
        .filter(file => file.startsWith('test') && file.endsWith('.js') && file !== 'run-all-tests.js')
        .sort(); // Sort for consistent order
    
    // Ensure main test.js runs first if it exists
    if (discoveredTests.includes('test.js')) {
      testFiles.push('./test.js');
      discoveredTests.splice(discoveredTests.indexOf('test.js'), 1);
    }
    
    // Add remaining tests
    testFiles.push(...discoveredTests.map(file => `./${file}`));
    
  } catch (error) {
    console.error(`${colors.red}Error: Could not scan test directory: ${error.message}${colors.reset}`);
    process.exit(1);
  }
  
  if (testFiles.length === 0) {
    console.warn(`${colors.yellow}Warning: No test files found${colors.reset}`);
    return { success: true, results: [] };
  }
  
  console.log(`${colors.blue}Found ${testFiles.length} test files:${colors.reset}`);
  testFiles.forEach(file => console.log(`  - ${file}`));
  console.log('');
  
  // Results tracking
  const results = [];
  let totalDuration = 0;
  const chromeBaseline = throttleConfig.enabled ? await readWindowsChromePressure() : null;

  if (throttleConfig.enabled) {
    const chromeBaselineText = chromeBaseline
      ? `, Chrome baseline ${chromeBaseline.count} proc / ${(chromeBaseline.workingSetBytes / GiB).toFixed(1)}GB`
      : '';
    console.log(`${colors.blue}Load throttle: CPU <= ${throttleConfig.maxCpuPct}%, free RAM >= ${throttleConfig.minFreeRamGB}GB${chromeBaselineText}${colors.reset}`);
  }
  
  // Run each test file
  for (const testFile of testFiles) {
    await waitForSystemCapacity(testFile, chromeBaseline);
    const result = await runTestFile(testFile);
    results.push(result);
    totalDuration += result.duration || 0;
    await coolDownAfterTest(testFile);
  }
  
  // Calculate summary statistics
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const failedTests = results.filter(r => !r.success);
  const skippedChecks = results.flatMap(r => (r.skipped || []).map(reason => ({ file: r.file, reason })));

  // Print detailed summary
  console.log(`\n${colors.bold}${colors.cyan}===== TEST SUMMARY =====${colors.reset}\n`);
  
  // Overall stats
  console.log(`${colors.bold}Overall Results:${colors.reset}`);
  console.log(`  Total tests:     ${passed + failed}`);
  console.log(`  ${colors.green}✓ Passed:        ${passed}${colors.reset}`);
  console.log(`  ${failed > 0 ? colors.red : colors.green}✗ Failed:        ${failed}${colors.reset}`);
  console.log(`  ${skippedChecks.length > 0 ? colors.yellow : colors.green}⚠️  Skipped checks: ${skippedChecks.length}${colors.reset}`);
  console.log(`  Total duration:  ${totalDuration}ms (${(totalDuration / 1000).toFixed(1)}s)`);

  // Skipped checks details: preconditions missing on this machine
  if (skippedChecks.length > 0) {
    console.log(`\n${colors.yellow}${colors.bold}Skipped Checks:${colors.reset}`);
    skippedChecks.forEach(({ file, reason }) => {
      console.log(`  ${colors.yellow}⚠️  ${file}: ${reason}${colors.reset}`);
    });
  }
  
  // Failed tests details
  if (failed > 0) {
    console.log(`\n${colors.red}${colors.bold}Failed Tests:${colors.reset}`);
    failedTests.forEach(test => {
      console.log(`  ${colors.red}✗ ${test.file}${colors.reset}`);
      if (test.exitCode !== undefined) {
        console.log(`    Exit code: ${test.exitCode}`);
      }
      if (test.error) {
        console.log(`    Error: ${test.error}`);
      }
    });
  }
  
  // Test performance summary
  if (results.length > 0) {
    console.log(`\n${colors.bold}Performance Summary:${colors.reset}`);
    const avgDuration = totalDuration / results.length;
    const slowestTest = results.reduce((prev, current) => 
      (current.duration || 0) > (prev.duration || 0) ? current : prev
    );
    const fastestTest = results.reduce((prev, current) => 
      (current.duration || 0) < (prev.duration || 0) ? current : prev
    );
    
    console.log(`  Average test duration: ${avgDuration.toFixed(0)}ms`);
    console.log(`  Fastest test: ${fastestTest.file} (${fastestTest.duration || 0}ms)`);
    console.log(`  Slowest test: ${slowestTest.file} (${slowestTest.duration || 0}ms)`);
  }
  
  // Final status
  if (failed === 0) {
    console.log(`\n${colors.green}${colors.bold}🎉 ALL TESTS PASSED! 🎉${colors.reset}`);
    console.log(`${colors.green}All ${passed} tests completed successfully.${colors.reset}`);
  } else {
    console.log(`\n${colors.red}${colors.bold}❌ TESTS FAILED ❌${colors.reset}`);
    console.log(`${colors.red}${failed} out of ${passed + failed} tests failed.${colors.reset}`);
  }
  
  console.log(`\n${colors.cyan}===== Test run completed =====${colors.reset}\n`);
  
  return {
    success: failed === 0,
    results,
    summary: {
      total: passed + failed,
      passed,
      failed,
      duration: totalDuration
    }
  };
}

/**
 * Main function
 */
async function main() {
  const overallStartTime = Date.now();
  
  try {
    console.log(`${colors.bold}${colors.cyan}===== DESKTOP COMMANDER TEST RUNNER =====${colors.reset}`);
    console.log(`${colors.blue}Starting test execution at ${new Date().toISOString()}${colors.reset}\n`);
    
    // Build the project first
    await buildProject();
    
    // Run all test modules
    const testResult = await runTestModules();
    
    // Final timing
    const overallDuration = Date.now() - overallStartTime;
    console.log(`${colors.blue}Total execution time: ${overallDuration}ms (${(overallDuration / 1000).toFixed(1)}s)${colors.reset}`);
    
    // Exit with appropriate code
    process.exit(testResult.success ? 0 : 1);
    
  } catch (error) {
    console.error(`\n${colors.red}${colors.bold}FATAL ERROR:${colors.reset}`);
    console.error(`${colors.red}${error.message}${colors.reset}`);
    if (error.stack) {
      console.error(`${colors.red}${error.stack}${colors.reset}`);
    }
    process.exit(error.code === 'CAPACITY_NOT_RUN' ? 77 : 1);
  }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  console.error(`\n${colors.red}${colors.bold}UNCAUGHT EXCEPTION:${colors.reset}`);
  console.error(`${colors.red}${error.message}${colors.reset}`);
  if (error.stack) {
    console.error(`${colors.red}${error.stack}${colors.reset}`);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`\n${colors.red}${colors.bold}UNHANDLED REJECTION:${colors.reset}`);
  console.error(`${colors.red}${reason}${colors.reset}`);
  process.exit(1);
});

// Run the main function
main().catch(error => {
  console.error(`\n${colors.red}${colors.bold}MAIN FUNCTION ERROR:${colors.reset}`);
  console.error(`${colors.red}${error.message}${colors.reset}`);
  if (error.stack) {
    console.error(`${colors.red}${error.stack}${colors.reset}`);
  }
  process.exit(1);
});
