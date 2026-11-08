import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMarkdownController } from '../dist/ui/file-preview/src/markdown/controller.js';

const dom = new JSDOM('<!doctype html><html><body><div class="panel-content-wrapper"></div></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const activeTimers = new Set();
const activeFrames = new Set();
let nextFrame = 1;
const realSetTimeout = dom.window.setTimeout.bind(dom.window);
const realClearTimeout = dom.window.clearTimeout.bind(dom.window);
dom.window.setTimeout = (callback, delay) => {
  let id;
  id = realSetTimeout(() => { activeTimers.delete(id); callback(); }, delay);
  activeTimers.add(id);
  return id;
};
dom.window.clearTimeout = (id) => { activeTimers.delete(id); realClearTimeout(id); };
dom.window.requestAnimationFrame = (callback) => { const id = nextFrame++; activeFrames.add(id); return id; };
dom.window.cancelAnimationFrame = (id) => { activeFrames.delete(id); };

const payload = { filePath: '/docs/notes.md', content: '# Notes', fileType: 'markdown' };
const controller = createMarkdownController({
  callTool: async () => ({ content: [] }),
  openExternalLink: async () => false,
  requestDisplayMode: async () => null,
  getAvailableDisplayModes: () => [],
  getCurrentDisplayMode: () => 'inline',
  getCurrentPayload: () => payload,
  setExpanded() {}, syncPayload() {}, storePayloadOverride() {}, rerender() {},
  updateSaveStatus() {},
});
controller.attachHandlers(payload);
controller.setEditorView(payload, 'raw');
assert.ok(activeTimers.size > 0, 'attachHandlers must schedule pending anchor work');
assert.ok(activeFrames.size > 0, 'view change must schedule scroll restoration');
controller.disposeHandles();
assert.equal(activeTimers.size, 0, 'disposeHandles must cancel transient timeouts');
assert.equal(activeFrames.size, 0, 'disposeHandles must cancel pending animation frames');
controller.dispose();
controller.dispose();

let resolvePendingRead;
const pendingController = createMarkdownController({
  callTool: () => new Promise((resolve) => { resolvePendingRead = resolve; }),
  openExternalLink: async () => false,
  requestDisplayMode: async () => null,
  getAvailableDisplayModes: () => [],
  getCurrentDisplayMode: () => 'inline',
  getCurrentPayload: () => payload,
  setExpanded() {}, syncPayload() {}, storePayloadOverride() {}, rerender() {},
  updateSaveStatus() {},
});
const pendingRead = pendingController.readPayload(payload.filePath);
assert.equal(typeof resolvePendingRead, 'function', 'readPayload should start the deferred host RPC');
pendingController.dispose();
resolvePendingRead({
  structuredContent: { fileName: 'notes.md', filePath: payload.filePath, fileType: 'markdown' },
  content: [{ type: 'text', text: '# Late response' }],
});
assert.equal(await pendingRead, null, 'a pending Markdown read must not publish payload after final disposal');
pendingController.dispose();
dom.window.close();
console.log('PASS markdown controller disposal cancels timers/frames and rejects late read results');
