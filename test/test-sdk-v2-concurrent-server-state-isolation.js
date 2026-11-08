import assert from 'node:assert/strict';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { createServerInstance } = await import('../dist/server.js');

// The lifecycle-level identity isolation contract is exercised end-to-end by
// test-sdk-v2-concurrent-server-transports.js. This focused factory test only
// verifies that the DC factory does not reuse a Server object.
const serverA = createServerInstance();
const serverB = createServerInstance();

assert.notEqual(serverA, serverB, 'the factory must produce distinct Server instances');

console.log('PASS concurrent Server factory returns independent instances');
