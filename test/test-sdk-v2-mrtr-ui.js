import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const runtimePath = fileURLToPath(new URL('../dist/ui/sdk-v2-mrtr/sdk-v2-mrtr-runtime.js', import.meta.url));
const runtime = fs.readFileSync(runtimePath, 'utf8');
const html = `<!doctype html><html><body>
  <main class="mrtr-card">
    <h1 id="mrtr-title">既定タイトル</h1>
    <p id="mrtr-copy">既定詳細</p>
    <button id="mrtr-accept" type="button">承認</button>
    <button id="mrtr-decline" type="button">取消</button>
    <div id="mrtr-status" role="status">承認または取消を選んでください。</div>
  </main>
</body></html>`;

const delay = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

function createHostDom() {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/sdk-v2-mrtr',
  });
  dom.window.openai = {
    toolOutput: {
      structuredContent: {
        proposalId: 'ui-choice-probe',
        prompt: '変更を実行しますか？',
        detail: '対象: sample.xlsx',
        choices: [{ id: 'accept', label: 'はい' }, { id: 'decline', label: 'いいえ' }],
      },
    },
  };
  if (!dom.window.requestAnimationFrame) {
    dom.window.requestAnimationFrame = callback => dom.window.setTimeout(() => callback(Date.now()), 0);
    dom.window.cancelAnimationFrame = id => dom.window.clearTimeout(id);
  }

  const calls = [];
  const hostResponses = [];
  const send = message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: message,
    source: dom.window,
  }));
  const reply = (id, result) => queueMicrotask(() => send({ jsonrpc: '2.0', id, result }));

  dom.window.postMessage = message => {
    if (message.method === 'ui/initialize') {
      reply(message.id, {
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'test-host', version: '1' },
        hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: { text: {} } },
        hostContext: {
          theme: 'dark',
          displayMode: 'inline',
          availableDisplayModes: ['inline'],
          initiallyExpanded: true,
          hideSummaryRow: false,
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      calls.push(message.params);
      const action = message.params?.arguments?.action;
      reply(message.id, {
        content: [{ type: 'text', text: `SDK v2 multi-round-trip App demo complete: ${action}. No changes were made.` }],
        structuredContent: { status: action, proposalId: 'sdk-v2-mrtr-demo' },
      });
      return;
    }
    if (message.id !== undefined && !message.method) {
      hostResponses.push(message);
      return;
    }
    if (message.id !== undefined && message.method) {
      reply(message.id, {});
    }
  };

  dom.window.eval(runtime);
  return { dom, calls, hostResponses };
}

async function assertDecision(buttonId, action) {
  const { dom, calls } = createHostDom();
  await delay(50);
  assert.equal(dom.window.document.getElementById('mrtr-title')?.textContent, '変更を実行しますか？');
  assert.equal(dom.window.document.getElementById('mrtr-copy')?.textContent, '対象: sample.xlsx');
  assert.equal(dom.window.document.getElementById('mrtr-accept')?.textContent, 'はい');
  assert.equal(dom.window.document.getElementById('mrtr-decline')?.textContent, 'いいえ');
  const button = dom.window.document.getElementById(buttonId);
  const otherButton = dom.window.document.getElementById(action === 'accept' ? 'mrtr-decline' : 'mrtr-accept');
  assert.ok(button, `missing ${buttonId}`);
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await delay(50);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, 'sdk_v2_multi_round_trip_demo_app_decide');
  assert.equal(calls[0]?.arguments?.origin, 'ui');
  assert.equal(calls[0]?.arguments?.action, action);
  assert.equal(calls[0]?.arguments?.proposalId, 'ui-choice-probe');
  assert.equal(button.hidden, true);
  assert.equal(otherButton.hidden, true);
  assert.match(dom.window.document.getElementById('mrtr-status')?.textContent ?? '', new RegExp(`complete: ${action}`));
  dom.window.close();
}

export default async function runTests() {
  await assertDecision('mrtr-accept', 'accept');
  await assertDecision('mrtr-decline', 'decline');

  const { dom, calls, hostResponses } = createHostDom();
  await delay(50);
  const acceptButton = dom.window.document.getElementById('mrtr-accept');
  const declineButton = dom.window.document.getElementById('mrtr-decline');
  const status = dom.window.document.getElementById('mrtr-status');
  acceptButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const pendingStatus = status.textContent;
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { jsonrpc: '2.0', id: 77, method: 'ui/resource-teardown', params: {} },
    source: dom.window.parent,
  }));
  const teardownResponse = hostResponses.find(message => message.id === 77);
  assert.equal(teardownResponse?.jsonrpc, '2.0');
  assert.equal(typeof teardownResponse?.result, 'object');
  assert.deepEqual(Object.keys(teardownResponse?.result ?? {}), [], 'MRTR UI must acknowledge the host resource-teardown request with an empty result');
  await delay(10);
  assert.equal(status.textContent, pendingStatus, 'a pending decision rejection must not update status after teardown');
  declineButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await delay(30);
  assert.equal(calls.length, 1, 'teardown must remove button listeners and prevent later decisions');
  assert.equal(status.textContent, pendingStatus, 'post-teardown clicks must not mutate the UI');
  dom.window.close();
  console.log('PASS: SDK v2 MRTR App buttons call the app-only decision tool and render the result');
  return true;
}

runIfMain(import.meta.url, runTests);