import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const posted = [];
  dom.window.parent.postMessage = message => posted.push(message);

  try {
    const { LiteMcpApp } = await import('../dist/ui/file-preview/src/lite-app.js');
    const app = new LiteMcpApp({ name: 'test', version: '1' }, {}, false);
    const connect = app.connect();
    const initialize = posted.find(message => message.method === 'ui/initialize');
    assert.ok(initialize, 'connect should send initialize request');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: dom.window,
      data: { jsonrpc: '2.0', id: initialize.id, result: { hostContext: {} } },
    }));
    await connect;

    let contextChanges = 0;
    let finishTeardown;
    app.onteardown = () => new Promise(resolve => { finishTeardown = resolve; });
    app.onhostcontextchanged = () => { contextChanges += 1; };
    const pending = app.callServerTool({ name: 'never_finishes' });
    const toolCall = posted.find(message => message.method === 'tools/call');
    assert.ok(toolCall, 'tool call should be sent before teardown');
    const settled = pending.then(
      () => ({ status: 'resolved' }),
      error => ({ status: 'rejected', message: error.message }),
    );

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: dom.window,
      data: { jsonrpc: '2.0', id: 900, method: 'ui/resource-teardown', params: {} },
    }));
    const result = await settled;
    assert.equal(result.status, 'rejected', 'pending RPC must settle immediately when teardown starts');
    assert.match(result.message, /resource torn down/);
    assert.equal(typeof finishTeardown, 'function', 'async teardown callback should still be running after pending RPCs settle');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: dom.window,
      data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
    }));
    assert.equal(contextChanges, 0, 'host notifications must be ignored as soon as teardown begins');
    finishTeardown({ cleaned: true });
    for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(posted.some(message => message.id === 900 && message.result?.cleaned), 'teardown request should receive a response after cleanup');
    assert.equal(app.onteardown, undefined, 'teardown callback must be released after it runs');
    assert.equal(app.onhostcontextchanged, undefined, 'host callback closures must be released after teardown');
    await assert.rejects(app.callServerTool({ name: 'after_teardown' }), /resource has been torn down/);

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: dom.window,
      data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } },
    }));
    assert.equal(contextChanges, 0, 'host messages must no longer be observed after teardown');
    console.log('PASS LiteMcpApp teardown settles pending RPCs and prevents post-teardown requests');
    return true;
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    dom.window.close();
  }
}

runIfMain(import.meta.url, runTests);
