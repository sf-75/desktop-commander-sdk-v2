import assert from 'node:assert/strict';
import { captureAppAutoResizeCleanup, closeAppAfterResourceTeardown } from '../dist/ui/shared/host-context.js';
import { App } from '@modelcontextprotocol/ext-apps';

const previousWindow = globalThis.window;
globalThis.window = { setTimeout: (callback, delay) => setTimeout(callback, delay) };

let observerConnected = false;
let disconnectCalls = 0;
let closeCalls = 0;
let sizeNotifications = 0;
const app = {
  sendSizeChanged() {
    sizeNotifications += 1;
    return Promise.resolve();
  },
  setupSizeChangedNotifications() {
    observerConnected = true;
    return () => {
      observerConnected = false;
      disconnectCalls += 1;
    };
  },
  close() {
    assert.equal(observerConnected, false, 'autoResize observer must be disconnected before transport close');
    closeCalls += 1;
    return Promise.resolve();
  },
};

try {
  const cleanup = captureAppAutoResizeCleanup(app);
  assert.equal(typeof cleanup, 'function', 'the SDK autoResize cleanup hook must be captured');
  app.setupSizeChangedNotifications();
  assert.equal(observerConnected, true);
  cleanup();
  assert.equal(observerConnected, false, 'explicit dispose disconnects the observer immediately');
  assert.equal(disconnectCalls, 1);
  await app.sendSizeChanged({ width: 100, height: 100 });
  assert.equal(sizeNotifications, 0, 'queued SDK resize callbacks cannot send notifications after dispose');

  closeAppAfterResourceTeardown(app, cleanup);
  assert.equal(closeCalls, 0, 'transport close must wait until the next task');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closeCalls, 1, 'transport closes after the resource-teardown response task');
  assert.equal(disconnectCalls, 1, 'cleanup is idempotent when called again before close');

  assert.equal(captureAppAutoResizeCleanup({}), undefined, 'unknown SDK versions without the hook are not force-closed');

  class PendingRequestTransport {
    onclose;
    onmessage;
    onerror;
    pending = [];

    async start() {}

    async send(message) {
      if (message.method === 'ui/initialize') {
        queueMicrotask(() => this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-21',
            hostInfo: { name: 'test-host', version: '1' },
            hostCapabilities: {},
            hostContext: {},
          },
        }));
      } else if (message.method === 'resources/list') {
        this.pending.push(message);
      }
    }

    deliver(message) {
      this.onmessage?.(message);
    }

    async close() {
      this.onclose?.();
    }
  }

  const transport = new PendingRequestTransport();
  const sdkApp = new App({ name: 'close-lifecycle-test', version: '1' }, {}, { autoResize: false });
  await sdkApp.connect(transport);
  const pendingRequest = sdkApp.listServerResources();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(transport.pending.length, 1, 'SDK request must remain pending before transport close');

  await sdkApp.close();
  let pendingRequestRejected = false;
  try {
    await pendingRequest;
  } catch (error) {
    pendingRequestRejected = true;
    assert.match(String(error), /Connection closed/i, 'SDK close should reject with ConnectionClosed');
  }
  assert.equal(pendingRequestRejected, true, 'App.close must settle pending SDK requests');
  assert.equal(sdkApp._responseHandlers.size, 0, 'Protocol close must clear pending response handlers');
  assert.equal(sdkApp._timeoutInfo.size, 0, 'Protocol close must clear request timeout timers');
  assert.equal(sdkApp._progressHandlers.size, 0, 'Protocol close must clear progress handlers');
  assert.equal(sdkApp._requestHandlerAbortControllers.size, 0, 'Protocol close must clear inbound request controllers');

  const inboundTransport = new PendingRequestTransport();
  const inboundApp = new App({ name: 'inbound-close-lifecycle-test', version: '1' }, {}, { autoResize: false });
  let inboundSignal;
  inboundApp.onteardown = (_params, context) => new Promise(resolve => {
    inboundSignal = context.mcpReq.signal;
    inboundSignal.addEventListener('abort', () => resolve({}), { once: true });
  });
  await inboundApp.connect(inboundTransport);
  inboundTransport.deliver({ jsonrpc: '2.0', id: 42, method: 'ui/resource-teardown', params: {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(inboundSignal instanceof AbortSignal, 'inbound SDK request should receive an AbortSignal');
  assert.equal(inboundSignal.aborted, false, 'inbound request should remain active before close');
  await inboundApp.close();
  assert.equal(inboundSignal.aborted, true, 'Protocol close must abort active inbound request handlers');
  assert.equal(inboundApp._requestHandlerAbortControllers.size, 0, 'inbound request controller registry must be empty after close');

  const failedConnectListeners = new Map();
  const failingParent = { postMessage() { throw new Error('simulated host postMessage failure'); } };
  globalThis.window = {
    parent: failingParent,
    addEventListener(type, listener) {
      const listeners = failedConnectListeners.get(type) ?? new Set();
      listeners.add(listener);
      failedConnectListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      failedConnectListeners.get(type)?.delete(listener);
    },
  };
  const failedConnectApp = new App({ name: 'failed-connect-lifecycle-test', version: '1' }, {}, { autoResize: false });
  let connectRejected = false;
  try {
    await failedConnectApp.connect();
  } catch (error) {
    connectRejected = true;
    assert.match(String(error), /simulated host postMessage failure/);
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(connectRejected, true, 'failed App.connect must reject the initialize handshake');
  assert.equal(failedConnectListeners.get('message')?.size ?? 0, 0, 'failed App.connect must remove the PostMessageTransport window listener');
  assert.equal(failedConnectApp._responseHandlers.size, 0, 'failed initialize must not retain response handlers');
  assert.equal(failedConnectApp._timeoutInfo.size, 0, 'failed initialize must not retain request timers');

  console.log('PASS App autoResize cleanup, SDK close settlement, inbound abort, and failed-connect transport cleanup');
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}
