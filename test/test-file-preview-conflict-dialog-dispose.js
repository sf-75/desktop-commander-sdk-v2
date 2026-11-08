import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createConflictDialogController, renderConflictDialogMarkup } from '../dist/ui/file-preview/src/markdown/conflict-dialog.js';

const dom = new JSDOM(`<!doctype html><html><body>${renderConflictDialogMarkup()}</body></html>`, {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;

let cancelled = 0;
let usedDisk = 0;
let savedMine = 0;
const controller = createConflictDialogController({ container: document });
controller.open({
  fileName: 'notes.md',
  onUseDiskVersion: () => usedDisk++,
  onSaveMyChanges: () => savedMine++,
  onCancel: () => cancelled++,
});
assert.equal(controller.isOpen(), true);
controller.dispose();
controller.dispose();
assert.equal(controller.isOpen(), false, 'dispose must hide an open dialog');
assert.equal(cancelled, 0, 'teardown must not masquerade as user cancellation');
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
document.getElementById('md-conflict-use-disk').click();
document.getElementById('md-conflict-save-mine').click();
document.getElementById('md-conflict-close').click();
assert.equal(cancelled, 0);
assert.equal(usedDisk, 0);
assert.equal(savedMine, 0);
let lateCancel = 0;
controller.open({
  fileName: 'late.md',
  onUseDiskVersion: () => {},
  onSaveMyChanges: () => {},
  onCancel: () => lateCancel++,
});
assert.equal(lateCancel, 1, 'late opens after teardown must take the safe cancel fallback');
assert.equal(controller.isOpen(), false);
dom.window.close();
console.log('PASS conflict dialog dispose releases document and button handlers and rejects late opens');
