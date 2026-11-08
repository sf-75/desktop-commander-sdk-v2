import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCompactRowShellController } from '../dist/ui/shared/tool-shell.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const dom = new JSDOM('<!doctype html><html><body><main id="shell"><button id="toggle" type="button">Toggle</button></main></body></html>');
  const shell = dom.window.document.getElementById('shell');
  const compactRow = dom.window.document.getElementById('toggle');
  let toggleCalls = 0;
  let renderCalls = 0;
  let scrollCalls = 0;
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;

  const controller = createCompactRowShellController({
    shell,
    compactRow,
    initialExpanded: false,
    onToggle: () => { toggleCalls += 1; },
    onRender: () => { renderCalls += 1; },
    onScrollAfterExpand: () => { scrollCalls += 1; },
  });

  assert.equal(controller.getExpanded(), false);
  assert.ok(shell.classList.contains('collapsed'));

  compactRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(controller.getExpanded(), true);
  assert.equal(toggleCalls, 1);
  assert.equal(renderCalls, 1);
  shell.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  assert.equal(scrollCalls, 1, 'scroll after expansion must be tracked once');

  controller.dispose();
  controller.dispose();
  compactRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  compactRow.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  controller.toggle();
  controller.setExpanded(false);
  shell.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
  dom.window.document.dispatchEvent(new dom.window.Event('scroll'));

  assert.equal(toggleCalls, 1, 'disposed controller must not invoke toggle callbacks');
  assert.equal(renderCalls, 1, 'disposed controller must not invoke render callbacks');
  assert.equal(scrollCalls, 1, 'disposed controller must remove shell and document scroll listeners');
  assert.equal(controller.getExpanded(), true, 'disposed controller state must remain stable');
  assert.ok(shell.classList.contains('expanded'), 'disposed controller must not mutate retained shell state');

  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousNode === undefined) delete globalThis.Node;
  else globalThis.Node = previousNode;
  dom.window.close();
  console.log('PASS: tool shell disposal is idempotent and disables retained controller methods');
  return true;
}

runIfMain(import.meta.url, runTests);
