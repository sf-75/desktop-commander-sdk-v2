import assert from 'assert';
import { JSDOM } from 'jsdom';

import { attachDirectoryHandlers, renderDirectoryBody } from '../dist/ui/file-preview/src/directory-controller.js';
import { attachSelectionContext } from '../dist/ui/file-preview/src/host/selection-context.js';
import { runIfMain } from './helpers/run-if-main.js';

async function testDirectoryBodyRendering() {
  console.log('\n--- Test: directory preview rendering ---');

  const listing = [
    'Directory listing for /tmp/project',
    '[DIR] docs',
    '[FILE] docs/readme.md',
    '[WARNING] docs: 8 items hidden (showing first 2 of 10 total)',
    '[DENIED] secrets',
  ].join('\n');

  const result = renderDirectoryBody(listing, '/tmp/project');
  assert.strictEqual(result.notice, 'Directory listing for /tmp/project');
  assert.ok(result.html.includes('dir-tree'), 'Directory preview should render the tree shell');
  assert.ok(result.html.includes('dir-row-folder'), 'Directory preview should render folder rows');
  assert.ok(result.html.includes('dir-row-file'), 'Directory preview should render file rows');
  assert.ok(result.html.includes('dir-load-more'), 'Directory preview should render load-more warnings');
  assert.ok(result.html.includes('dir-name-denied'), 'Directory preview should render denied entries');

  console.log('✓ directory preview renders folder, file, warning, and denied states');
}

async function testDirectoryHandlersAbortPendingWork() {
  console.log('\\n--- Test: directory handlers abort pending RPC side effects ---');
  const dom = new JSDOM('<!doctype html><html><body><div id="container"><div class="dir-tree"><div class="dir-children"><button class="dir-load-more" data-loadpath="/tmp/project/docs"><span class="dir-warning-text">Load more</span></button></div></div></div></body></html>');
  const previousAbortController = globalThis.AbortController;
  globalThis.AbortController = dom.window.AbortController;
  const container = dom.window.document.getElementById('container');
  let resolveRead;
  let openedPayloads = 0;
  const controller = attachDirectoryHandlers({
    container,
    callTool: () => new Promise(resolve => { resolveRead = resolve; }),
    buildOpenInFolderCommand: () => undefined,
    onOpenPayload: () => { openedPayloads += 1; },
  });
  assert.ok(controller, 'directory handler should return its lifecycle controller');
  const loadMore = container.querySelector('.dir-load-more');
  loadMore.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(typeof resolveRead, 'function', 'load-more click should start the pending RPC');
  const htmlAtAbort = container.innerHTML;
  controller.abort();
  resolveRead({ content: [{ type: 'text', text: '[FILE] late.txt' }] });
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(container.innerHTML, htmlAtAbort, 'late directory response must not mutate the tree after abort');
  assert.equal(openedPayloads, 0, 'aborted directory handler must not publish payloads');
  dom.window.close();
  if (previousAbortController === undefined) delete globalThis.AbortController;
  else globalThis.AbortController = previousAbortController;
  console.log('✓ directory handler abort prevents late RPC DOM/payload side effects');
}

async function testSelectionContextAbortCleanup() {
  console.log('\\n--- Test: selection context abort removes hint and clears host context ---');
  const dom = new JSDOM('<!doctype html><html><body><div class="panel-content-wrapper"><div class="code-line" data-line="7">selected words</div></div></body></html>');
  const previousAbortController = globalThis.AbortController;
  const previousDocument = globalThis.document;
  globalThis.AbortController = dom.window.AbortController;
  globalThis.document = dom.window.document;
  const wrapper = dom.window.document.querySelector('.panel-content-wrapper');
  wrapper.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 200, width: 320, height: 200, x: 0, y: 0, toJSON() {} });
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 20, top: 30, right: 120, bottom: 45, width: 100, height: 15, x: 20, y: 30, toJSON() {} });
  const textNode = wrapper.querySelector('.code-line').firstChild;
  const range = dom.window.document.createRange();
  range.selectNodeContents(textNode);
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const contexts = [];
  const controller = attachSelectionContext({
    payload: { filePath: '/tmp/source.ts', fileType: 'text' },
    isMarkdownEditing: false,
    updateContext: value => contexts.push(value),
    getFileExtensionForAnalytics: () => '.ts',
    previousAbortController: null,
  });
  dom.window.document.dispatchEvent(new dom.window.Event('selectionchange'));
  assert.ok(dom.window.document.querySelector('.selection-hint'), 'selection should create its hint');
  assert.ok(contexts.at(-1).includes('selected words'), 'selection should publish selected text');
  controller.abort();
  assert.equal(dom.window.document.querySelector('.selection-hint'), null, 'abort must remove the hint immediately');
  assert.equal(contexts.at(-1), '', 'abort must clear previously published selection context');
  if (previousAbortController === undefined) delete globalThis.AbortController;
  else globalThis.AbortController = previousAbortController;
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  dom.window.close();
  console.log('✓ selection context abort clears hint, timer, and host context');
}

export default async function runTests() {
  try {
    await testDirectoryBodyRendering();
    await testDirectoryHandlersAbortPendingWork();
    await testSelectionContextAbortCleanup();
    console.log('\n✅ File preview directory runtime tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

runIfMain(import.meta.url, runTests);
