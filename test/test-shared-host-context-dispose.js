import assert from 'node:assert/strict';
import { connectWithSharedHostContext } from '../dist/ui/shared/host-context.js';

let resolveConnect;
let applied = 0;
let connected = 0;
const controller = new AbortController();
const app = {
  onhostcontextchanged: undefined,
  connect: () => new Promise((resolve) => { resolveConnect = resolve; }),
  getHostContext: () => ({ theme: 'dark' }),
};

const pendingConnect = connectWithSharedHostContext({
  app,
  chrome: { expanded: false, hideSummaryRow: false },
  signal: controller.signal,
  onContextApplied: () => { applied += 1; },
  onConnected: () => { connected += 1; },
});

const capturedHandler = app.onhostcontextchanged;
assert.equal(typeof capturedHandler, 'function', 'host-context handler is installed during connect');
controller.abort();
assert.equal(app.onhostcontextchanged, undefined, 'abort immediately clears the App callback');
capturedHandler?.({ theme: 'dark' });
resolveConnect();
await pendingConnect;
assert.equal(applied, 0, 'captured late host-context callbacks are ignored after abort');
assert.equal(connected, 0, 'onConnected is skipped when connect resolves after abort');

const alreadyAborted = new AbortController();
alreadyAborted.abort();
const untouchedApp = {
  onhostcontextchanged: undefined,
  connect: () => { throw new Error('connect must not run after abort'); },
  getHostContext: () => undefined,
};
await connectWithSharedHostContext({
  app: untouchedApp,
  chrome: { expanded: false, hideSummaryRow: false },
  signal: alreadyAborted.signal,
});
assert.equal(untouchedApp.onhostcontextchanged, undefined, 'already-aborted signals do not install callbacks');

console.log('PASS shared host-context connection clears callbacks and suppresses late completion after abort');
