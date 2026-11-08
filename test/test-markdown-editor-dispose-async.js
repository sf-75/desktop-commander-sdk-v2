import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.DOMParser = dom.window.DOMParser;
  globalThis.getComputedStyle = dom.window.getComputedStyle;

  const { mountMarkdownEditor } = await import('../dist/ui/file-preview/src/markdown/editor.js');
  const shell = document.createElement('div');
  shell.className = 'markdown-editor-shell';
  shell.innerHTML = `
    <div id="markdown-editor-context-menu"></div>
    <div id="markdown-editor-root"></div>
    <div id="markdown-link-modal">
      <button id="markdown-link-mode-file" type="button"></button>
      <button id="markdown-link-mode-url" type="button"></button>
      <div id="markdown-link-file-fields">
        <input id="markdown-link-search" />
        <div id="markdown-link-results"></div>
        <select id="markdown-link-heading"></select>
        <input id="markdown-link-alias" />
      </div>
      <div id="markdown-link-url-fields">
        <input id="markdown-link-input" />
        <input id="markdown-link-label" />
      </div>
      <button id="markdown-link-apply" type="button"></button>
      <button id="markdown-link-cancel" type="button"></button>
    </div>
  `;
  document.body.appendChild(shell);

  let resolveSearch;
  let resolveHeadings;
  const searchPromise = new Promise((resolve) => { resolveSearch = resolve; });
  const headingsPromise = new Promise((resolve) => { resolveHeadings = resolve; });
  let headingCalls = 0;
  const target = shell.querySelector('#markdown-editor-root');
  const resultsNode = shell.querySelector('#markdown-link-results');
  const headingSelect = shell.querySelector('#markdown-link-heading');
  const editor = mountMarkdownEditor({
    target,
    value: '# Lifecycle test\\n',
    view: 'markdown',
    currentFilePath: '/tmp/current.md',
    searchLinks: () => searchPromise,
    loadHeadings: () => { headingCalls += 1; return headingsPromise; },
    onChange() {},
  });

  const searchInput = shell.querySelector('#markdown-link-search');
  searchInput.value = 'target';
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await Promise.resolve();
  assert.equal(typeof resolveSearch, 'function', 'link search should start');

  resolveSearch([{
    path: '/tmp/target.md',
    title: 'Target',
    wikiPath: 'Target',
    relativePath: '../target.md',
  }]);
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(headingCalls, 1, 'successful search should start heading lookup');
  const resultsAtDestroy = resultsNode.innerHTML;
  const headingsAtDestroy = headingSelect.innerHTML;

  editor.destroy();
  editor.destroy();
  resolveHeadings([{ id: 'heading', text: 'Heading' }]);
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(resultsNode.innerHTML, resultsAtDestroy, 'late search work must not mutate results after destroy');
  assert.equal(headingSelect.innerHTML, headingsAtDestroy, 'late heading lookup must not mutate controls after destroy');
  assert.equal(target.childElementCount, 0, 'destroy must release the editor DOM');

  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.HTMLElement;
  delete globalThis.Node;
  delete globalThis.DOMParser;
  delete globalThis.getComputedStyle;
  console.log('PASS markdown editor disposal invalidates pending link search and heading lookup');
  return true;
}

runIfMain(import.meta.url, runTests);
