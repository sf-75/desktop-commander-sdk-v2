import assert from 'node:assert/strict';
import { getOSSpecificGuidance } from '../dist/utils/system-info.js';
import { runIfMain } from './helpers/run-if-main.js';

const base = {
  platformName: 'Linux',
  defaultShell: '/bin/sh',
  isWindows: false,
  isMacOS: false,
  isLinux: true,
  docker: {
    isContainer: true,
    containerType: 'docker',
    orchestrator: 'docker-compose',
    isDocker: true,
    mountPoints: [],
    containerEnvironment: { containerName: 'fd1cb95d1f61' },
  },
};

async function runTests() {
  const first = getOSSpecificGuidance(base);
  const second = getOSSpecificGuidance({
    ...base,
    docker: {
      ...base.docker,
      containerEnvironment: { containerName: '6f6d4f1f57de' },
    },
  });
  assert.equal(first, second, 'Docker hostnames must not alter model-facing tool descriptions');
  assert.match(first, /DOCKER CONTAINER ENVIRONMENT DETECTED/);
  assert.doesNotMatch(first, /fd1cb95d1f61|6f6d4f1f57de/);

  const lxc = getOSSpecificGuidance({
    ...base,
    docker: {
      ...base.docker,
      containerType: 'lxc',
      isDocker: false,
      orchestrator: null,
      containerEnvironment: { containerName: 'stable-lxc-name' },
    },
  });
  assert.match(lxc, /Container: stable-lxc-name/, 'non-Docker container names should remain available');

  console.log('PASS: Docker hostname does not change model-facing tool descriptions');
  return true;
}

runIfMain(import.meta.url, runTests);
export default runTests;
