import assert from 'node:assert/strict';
import { MCPDevice } from '../dist/remote-device/device.js';

const baselineInt = process.listenerCount('SIGINT');
const baselineTerm = process.listenerCount('SIGTERM');
const hostListener = () => {};
process.on('SIGINT', hostListener);
const withHostInt = process.listenerCount('SIGINT');

const device = new MCPDevice();
assert.equal(process.listenerCount('SIGINT'), withHostInt,
  'constructing an inactive device must not install process signal handlers');
assert.equal(process.listenerCount('SIGTERM'), baselineTerm);

device.setupShutdownHandlers();
device.setupShutdownHandlers();
assert.equal(process.listenerCount('SIGINT'), withHostInt + 1,
  'starting signal handling twice must not duplicate the handler');
assert.equal(process.listenerCount('SIGTERM'), baselineTerm + 1);

device.remoteChannel = {
  stopHeartbeat() {},
  unsubscribe: async () => {},
  setOffline: async () => {},
};
device.desktop = { shutdown: async () => {} };
await device.shutdown();
assert.equal(process.listenerCount('SIGINT'), withHostInt,
  'device shutdown must remove only its own SIGINT handler');
assert.equal(process.listenerCount('SIGTERM'), baselineTerm,
  'device shutdown must remove its SIGTERM handler');
process.off('SIGINT', hostListener);
assert.equal(process.listenerCount('SIGINT'), baselineInt);
console.log('PASS MCPDevice signal handlers are installed on demand and removed on shutdown');
