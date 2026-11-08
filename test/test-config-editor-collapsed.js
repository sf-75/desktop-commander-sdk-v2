import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const runtimePath = fileURLToPath(new URL('../dist/ui/config-editor/config-editor-runtime.js', import.meta.url));
const runtime = fs.readFileSync(runtimePath, 'utf8');
const payload = {
  config: { telemetryEnabled: false },
  uiHints: { availableShells: ['powershell.exe'] },
  entries: [
    { key: 'telemetryEnabled', value: false, valueType: 'boolean', editable: true },
    { key: 'allowedDirectories', value: ['C:\\Temp'], valueType: 'array', editable: true },
  ],
};

const delay = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

function createHostDom(sendInitialToolResult) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'dangerously',
    url: 'https://example.test/config',
  });
  dom.window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  if (!dom.window.requestAnimationFrame) {
    dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0);
    dom.window.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
  }

  const calls = [];
  const send = (message) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: message,
    source: dom.window,
  }));
  const reply = (id, result) => queueMicrotask(() => send({ jsonrpc: '2.0', id, result }));

  dom.window.postMessage = (message) => {
    if (message.method === 'ui/initialize') {
      reply(message.id, {
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'test-host', version: '1' },
        hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } },
        hostContext: {
          theme: 'dark',
          displayMode: 'inline',
          availableDisplayModes: ['inline', 'fullscreen'],
          initiallyExpanded: true,
          hideSummaryRow: false,
        },
      });
      if (sendInitialToolResult) {
        dom.window.setTimeout(() => send({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: { content: [], structuredContent: payload },
        }), 5);
      }
      return;
    }
    if (message.method === 'tools/call') {
      calls.push(message.params);
      const result = message.params?.name === 'get_config'
        ? { content: [], structuredContent: payload }
        : { content: [] };
      reply(message.id, result);
      return;
    }
    if (message.id !== undefined && message.method) {
      reply(message.id, {});
    }
  };

  dom.window.eval(runtime);
  return { dom, calls };
}

export default async function runTests() {
  {
    const { dom, calls } = createHostDom(true);
    await delay(80);
    const shell = dom.window.document.querySelector('#tool-shell');
    const toggle = dom.window.document.querySelector('#compact-toggle');
    assert.ok(shell?.classList.contains('collapsed'), 'Config editor must start collapsed');
    assert.ok(!shell?.classList.contains('expanded'), 'Host initiallyExpanded must not force it open');
    assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
    assert.equal(calls.filter(call => call?.name === 'get_config').length, 0, 'Collapsed editor must not refresh config');

    toggle?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await delay(50);
    assert.ok(shell?.classList.contains('expanded'), 'User click must expand config editor');
    assert.equal(calls.filter(call => call?.name === 'get_config').length, 0, 'Existing tool result must be reused on expand');
    dom.window.close();
  }

  {
    const { dom, calls } = createHostDom(false);
    await delay(80);
    const toggle = dom.window.document.querySelector('#compact-toggle');
    assert.equal(calls.filter(call => call?.name === 'get_config').length, 0, 'No background get_config before click');
    toggle?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await delay(50);
    assert.equal(calls.filter(call => call?.name === 'get_config').length, 1, 'Missing payload should refresh once after user click');
    dom.window.close();
  }

  {
    const { dom } = createHostDom(false);
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    await delay(30);
    assert.equal(
      dom.window.document.querySelector('#tool-shell'),
      null,
      'beforeunload must cancel the pending initial render and prevent late host callbacks from rendering'
    );
    dom.window.close();
  }

  {
    const { dom } = createHostDom(false);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 99, method: 'ui/resource-teardown', params: {} },
      source: dom.window,
    }));
    await delay(30);
    assert.equal(
      dom.window.document.querySelector('#tool-shell'),
      null,
      'host resource teardown must cancel the pending initial render'
    );
    dom.window.close();
  }

  {
    const { dom } = createHostDom(true);
    await delay(80);
    const editButton = dom.window.document.querySelector('[data-action="open-array"]');
    assert.ok(editButton, 'Array setting editor button must be rendered');
    editButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    const modal = dom.window.document.querySelector('#array-modal');
    assert.ok(modal && !modal.hidden, 'Array modal must open before teardown');

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 100, method: 'ui/resource-teardown', params: {} },
      source: dom.window,
    }));
    await delay(30);
    assert.equal(
      dom.window.document.querySelector('#array-modal'),
      null,
      'host resource teardown must release the array modal DOM and its event-handler graph'
    );
    dom.window.close();
  }

  console.log('PASS: config editor collapsed by default, refreshes on demand, and tears down pending UI work');
  return true;
}

runIfMain(import.meta.url, runTests);
