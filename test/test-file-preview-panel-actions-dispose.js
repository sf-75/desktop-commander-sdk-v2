import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const dom = new JSDOM('<!doctype html><html><body><div id="panel"><button id="load-before">Load before</button><button id="load-after">Load after</button><button id="open-in-folder">Open folder</button><button id="open-in-editor">Open editor</button><button id="copy-source">Copy</button></div></body></html>');
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousAbortController = globalThis.AbortController;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.AbortController = dom.window.AbortController;

  try {
    const { attachPanelActions } = await import('../dist/ui/file-preview/src/panel-actions.js');
    const container = dom.window.document.getElementById('panel');
    const payload = {
      filePath: '/tmp/partial.txt',
      fileType: 'text',
      content: '[Reading 10 lines from line 11 (total: 20 lines, 10 remaining)]\\nline 11\\nline 12',
    };
    let resolveRead;
    let renderCalls = 0;
    const controller = attachPanelActions({
      container,
      payload,
      htmlMode: 'rendered',
      getIsExpanded: () => false,
      callTool: () => new Promise(resolve => { resolveRead = resolve; }),
      trackUiEvent() {},
      getFileExtensionForAnalytics: () => '.txt',
      buildOpenInFolderCommand: () => 'open-folder',
      buildOpenInEditorCommand: () => 'open-editor',
      render: () => { renderCalls += 1; },
      updateSaveStatus() {},
      markdownController: { getCopyText: () => '' },
    });

    const loadBefore = container.querySelector('#load-before');
    loadBefore.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(typeof resolveRead, 'function', 'load-before should start a pending read');
    assert.equal(loadBefore.disabled, true);
    controller.abort();
    resolveRead({ content: [{ type: 'text', text: 'first ten lines' }] });
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(renderCalls, 0, 'late partial-read response must not rerender after abort');
    assert.equal(loadBefore.textContent, 'Loading…', 'aborted handler must not update its detached button');
    assert.equal(loadBefore.disabled, true);
    controller.abort();

    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousAbortController === undefined) delete globalThis.AbortController;
    else globalThis.AbortController = previousAbortController;
    dom.window.close();
    console.log('PASS panel actions abort pending RPC continuations and clear owned timers');
    return true;
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousAbortController === undefined) delete globalThis.AbortController;
    else globalThis.AbortController = previousAbortController;
    dom.window.close();
  }
}

runIfMain(import.meta.url, runTests);
