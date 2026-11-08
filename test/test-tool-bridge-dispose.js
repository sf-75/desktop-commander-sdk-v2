import assert from 'node:assert/strict';
import { runIfMain } from './helpers/run-if-main.js';
import { createToolBridge } from '../dist/ui/shared/tool-bridge.js';

export default async function runTests() {
  const listeners = new Set();
  const posted = [];
  const parent = { postMessage: message => posted.push(message) };
  const host = {
    parent,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const activeTimers = new Set();
  globalThis.setTimeout = (callback, delay, ...args) => {
    const timer = originalSetTimeout(callback, delay, ...args);
    activeTimers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => {
    activeTimers.delete(timer);
    return originalClearTimeout(timer);
  };

  try {
    const bridge = createToolBridge({ host, requestTimeoutMs: 60000, targetOrigin: '*' });
    const pending = bridge.callTool('never_finishes', { path: '/tmp/file.txt' });
    assert.equal(listeners.size, 1, 'fallback request should install one message listener');
    assert.equal(activeTimers.size, 1, 'fallback request should own one timeout');
    assert.equal(posted[0].method, 'tools/call');
    bridge.dispose();
    bridge.dispose();
    assert.equal(listeners.size, 0, 'dispose must remove pending fallback listeners');
    assert.equal(activeTimers.size, 0, 'dispose must clear pending fallback timeouts');
    await assert.rejects(pending, /disposed/);
    await assert.rejects(bridge.callTool('after_dispose'), /disposed/);

    let resolveHelper;
    const helperBridge = createToolBridge({
      host: { openai: { callTool: () => new Promise(resolve => { resolveHelper = resolve; }) } },
    });
    const helperPending = helperBridge.callTool('helper_never_finishes');
    helperBridge.dispose();
    await assert.rejects(helperPending, /disposed/, 'dispose must settle pending helper calls locally');
    resolveHelper({ content: [] });

    const responseBridge = createToolBridge({ host, requestTimeoutMs: 60000, targetOrigin: '*' });
    const responsePending = responseBridge.callTool('responds');
    const request = posted.at(-1);
    const listener = [...listeners][0];
    listener({ source: parent, origin: 'https://host.test', data: { jsonrpc: '2.0', id: request.id, result: { ok: true } } });
    assert.deepEqual(await responsePending, { ok: true });
    assert.equal(listeners.size, 0, 'normal response must remove its listener');
    assert.equal(activeTimers.size, 0, 'normal response must clear its timeout');
    responseBridge.dispose();

    console.log('PASS tool bridge disposal settles pending calls and clears fallback listeners/timers');
    return true;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

runIfMain(import.meta.url, runTests);
