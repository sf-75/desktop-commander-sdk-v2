/**
 * Lightweight, isolated contract checks for the optional root-runner capacity wait.
 * No build, npm, shell, network, real process termination, or host resource sampling.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const source = fs.readFileSync(new URL('./run-all-tests.js', import.meta.url), 'utf8');
const start = source.indexOf('async function waitForSystemCapacity(');
const end = source.indexOf('\nasync function coolDownAfterTest(', start);
assert(start >= 0 && end > start, 'runner capacity function must be locatable');

async function scenario({ maxWaitMs, samples, free, expectedError, expectedSleeps, expectedChecks }) {
  let cpuIndex = 0, freeIndex = 0, sleeps = 0;
  const output = [];
  const cfg = {
    enabled: true, maxCpuPct: 90, minFreeRamGB: 2, maxWaitMs,
    cpuSampleMs: 1, pollMs: 1
  };
  const ctx = vm.createContext({
    throttleConfig: cfg,
    sampleCpuPct: async () => samples[Math.min(cpuIndex++, samples.length - 1)],
    os: { freemem: () => free[Math.min(freeIndex++, free.length - 1)] * 1024 ** 3 },
    GiB: 1024 ** 3,
    readWindowsChromePressure: async () => null,
    isBrowserHeavyTest: () => false,
    sleep: async () => { sleeps++; },
    console: { log: msg => output.push(msg) },
    colors: { yellow: '', green: '', reset: '' }
  });
  vm.runInContext(source.slice(start, end), ctx);
  let error;
  try { await vm.runInContext('waitForSystemCapacity("test-capacity-contract.js", null)', ctx); }
  catch (e) { error = e; }
  if (expectedError) {
    assert.equal(error?.code, 'CAPACITY_NOT_RUN');
    assert.match(error?.message, /^NOT RUN: capacity gate could not clear/);
  } else {
    assert.equal(error, undefined);
  }
  assert.equal(sleeps, expectedSleeps);
  assert.equal(cpuIndex, expectedChecks);
  return output;
}

await scenario({ maxWaitMs: 5, samples: [5], free: [8], expectedError: false, expectedSleeps: 0, expectedChecks: 1 });
await scenario({ maxWaitMs: 5, samples: [98, 6, 7], free: [8, 8, 8], expectedError: false, expectedSleeps: 2, expectedChecks: 3 });
const failLog = await scenario({ maxWaitMs: 4, samples: [5, 5], free: [1, 1], expectedError: true, expectedSleeps: 2, expectedChecks: 2 });
assert(failLog.some(line => line.includes('Throttling before')));

const statusMatch = source.match(/process\.exit\(error\.code === 'CAPACITY_NOT_RUN' \? (\d+) : (\d+)\)/);
assert(statusMatch, 'the production catch must map capacity NOT RUN to a distinct exit code');
assert.equal(Number(statusMatch[1]), 77);
assert.equal(Number(statusMatch[2]), 1);
for (const [code, expected] of [['CAPACITY_NOT_RUN', 77], ['SOME_OTHER_FAILURE', 1]]) {
  const expression = `process.exit(({ code: ${JSON.stringify(code)} }).code === 'CAPACITY_NOT_RUN' ? ${statusMatch[1]} : ${statusMatch[2]})`;
  const child = spawnSync(process.execPath, ['-e', expression], { timeout: 3000, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, expected, `real subprocess exit status for ${code}`);
}
console.log('PASS capacity normal, recovery, timeout and NOT RUN exit 77 contract');
