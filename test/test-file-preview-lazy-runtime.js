import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

import {
  PREVIEW_MAX_LINES, PREVIEW_MAX_TEXT_BYTES,
  boundedPreviewReadArgs, boundPreviewRenderPayload,
  createLazyPreviewState, createLazyStateFromLegacy, isLazyPreviewState,
} from '../dist/ui/file-preview/src/lazy-preview-state.js';

const fakeAppModule = [
  'export class App {',
  '  constructor() { this.calls=[]; this.deferRead=false; this.pendingReadResolvers=[]; this.host={hideSummaryRow:true,initiallyExpanded:true,displayMode:"inline",availableDisplayModes:["inline","fullscreen"]}; window.__dcApp=this; }',
  '  async connect() {}',
  '  getHostContext() {return this.host;}',
  '  async callServerTool({name, arguments:args}) {',
  '    this.calls.push({name,args});',
  '    if (name==="read_file" && this.deferRead) return new Promise(resolve => { this.pendingReadResolvers.push(resolve); });',
  '    if (name==="read_file") return {structuredContent:{fileName:"notes.txt",filePath:args.path,fileType:args.path.endsWith(".md")?"markdown":"text"},content:[{type:"text",text:"visible text"}]};',
  '    return {content:[]};',
  '  }',
  '  async requestDisplayMode({mode}) {this.host.displayMode=mode;return {mode};}',
  '  async openLink() {return {isError:false};}',
  '  async updateModelContext() {}',
  '}',
  'export function applyDocumentTheme() {}',
  'export function applyHostFonts() {}',
  'export function applyHostStyleVariables() {}',
].join('\n');

async function buildPreviewHarness() {
  const entry = fileURLToPath(new URL('../src/ui/file-preview/src/main.ts', import.meta.url));
  const output = await build({
    entryPoints: [entry],
    bundle: true, write: false, platform: 'browser', format: 'iife',
    target: ['es2020'], minify: true,
    plugins: [{
      name: 'test-ext-apps',
      setup(build) {
        build.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({ path: 'fake-ext-apps', namespace: 'test-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'test-stub' }, () => ({ contents: fakeAppModule, loader: 'js' }));
      },
    }],
  });
  return output.outputFiles[0].text;
}

async function mount(bundle, persistedState, { persistWrites = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'outside-only', url: 'https://example.test/widget',
  });
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  dom.window.openai = {
    widgetState: persistedState,
    setWidgetState(value) { if (persistWrites) this.widgetState = value; },
  };
  dom.window.eval(bundle);
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
  return dom;
}

async function testBoundsAndMetadata() {
  const partial = createLazyPreviewState({ path: '/docs/notes.md', offset: 2, length: 5 });
  assert.ok(isLazyPreviewState(partial));
  assert.deepEqual(boundedPreviewReadArgs(partial), {
    path: '/docs/notes.md', offset: 2, length: 5, origin: 'ui', options: { maxBytes: PREVIEW_MAX_TEXT_BYTES },
  });
  assert.equal(boundedPreviewReadArgs(createLazyPreviewState({ path: '/docs/a.txt' })).length, PREVIEW_MAX_LINES);
  assert.equal(boundedPreviewReadArgs(createLazyPreviewState({ path: '/docs/a.txt', length: 5000 })).length, PREVIEW_MAX_LINES);
  assert.equal(boundedPreviewReadArgs(createLazyPreviewState({ path: '/docs/a.txt', offset: -500 })).offset, -PREVIEW_MAX_LINES);
  assert.deepEqual(
    boundedPreviewReadArgs(createLazyPreviewState({ path: 'https://example.test', isUrl: true })),
    { path: 'https://example.test', isUrl: true, origin: 'ui', options: { maxBytes: PREVIEW_MAX_TEXT_BYTES } },
  );
  const legacy = createLazyStateFromLegacy({
    filePath: '/docs/notes.md', fileName: 'notes.md', fileType: 'markdown',
    content: '[Reading 5 lines from start (total: 100 lines, 95 remaining)]\n# Test',
  });
  assert.equal(legacy.readArgs.path, '/docs/notes.md');
  assert.equal(legacy.readArgs.length, 5);
  assert.equal(JSON.stringify(legacy).includes('# Test'), false, 'legacy content must not remain in widget state');

  const huge = { filePath: '/docs/a.txt', fileName: 'a.txt', fileType: 'text', content: 'a'.repeat(400000) };
  assert.ok(boundPreviewRenderPayload(huge).content.length < PREVIEW_MAX_TEXT_BYTES + 120);
  assert.equal(boundPreviewRenderPayload({ ...huge, fileType: 'markdown' }).content.length, 400000);
}

async function testLightShellTeardown() {
  const entry = fileURLToPath(new URL('../src/ui/file-preview/src/light-main.ts', import.meta.url));
  const output = await build({
    entryPoints: [entry],
    bundle: true, write: false, platform: 'browser', format: 'iife',
    target: ['es2020'], minify: true,
  });
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'outside-only', url: 'https://example.test/light-preview',
  });
  try {
    const { window } = dom;
    const posted = [];
    window.parent.postMessage = (message) => {
      posted.push(message);
      if (message.method === 'ui/initialize') {
        queueMicrotask(() => window.dispatchEvent(new window.MessageEvent('message', {
          data: {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2026-01-26',
              hostInfo: { name: 'test-host', version: '1' },
              hostCapabilities: {},
              hostContext: { theme: 'dark', displayMode: 'inline' },
            },
          },
          source: window.parent,
        })));
      }
    };
    window.eval(output.outputFiles[0].text);
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));

    window.dispatchEvent(new window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: { arguments: { path: '/tmp/light-preview.txt' } },
      },
      source: window.parent,
    }));
    assert.ok(window.document.querySelector('.lazy-preview-open'), 'lightweight preview card must render');

    window.dispatchEvent(new window.MessageEvent('message', {
      data: { jsonrpc: '2.0', id: 77, method: 'ui/resource-teardown', params: {} },
      source: window.parent,
    }));
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(window.document.getElementById('app').childElementCount, 0,
      'lightweight preview teardown must detach the button and its listener closure');
    assert.ok(posted.some(message => message.id === 77 && message.result),
      'lightweight preview must acknowledge resource teardown');
  } finally {
    dom.window.close();
  }
}

async function testOnDemandRuntime(bundle) {
  const dom = await mount(bundle, null);
  try {
    const { window } = dom;
    const app = window.__dcApp;
    assert.ok(app, 'app must connect to host');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0, 'initial mount must not read');
    for (let i = 0; i < 100; i++) {
      app.ontoolinput({ arguments: { path: '/tmp/notes.txt', offset: 0, length: 5 } });
      app.ontoolresult({ content: [{ type: 'text', text: 'model-side result' }] });
    }
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0, '100 unopened cards must not cause UI-origin reads');
    assert.ok(window.document.querySelector('.lazy-preview-open'), 'host-framed mode must show a clickable card');
    assert.ok(!window.document.getElementById('app').textContent.includes('visible text'), 'text must not be rendered while closed');
    assert.ok(isLazyPreviewState(window.openai.widgetState.payload), 'only descriptor is persisted');

    window.document.querySelector('.lazy-preview-open').click();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const reads = app.calls.filter(x => x.name === 'read_file');
    assert.equal(reads.length, 1, 'opening must cause exactly one UI-origin read');
    assert.equal(reads[0].args.origin, 'ui');
    assert.equal(reads[0].args.offset, 0);
    assert.equal(reads[0].args.length, 5);
    assert.ok(window.document.getElementById('app').textContent.includes('visible text'), 'content must be visible after opening');

    assert.ok(window.document.getElementById('close-preview-outer'), 'touch-friendly close control must remain visible');
    window.document.getElementById('close-preview-outer').click();
    assert.ok(window.document.querySelector('.lazy-preview-open'), 'close must restore lightweight card');
    assert.ok(!window.document.getElementById('app').textContent.includes('visible text'), 'close must destroy content DOM');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 1, 'closing must not cause a second read');

    window.document.querySelector('.lazy-preview-open').click();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const reopenedReads = app.calls.filter(x => x.name === 'read_file');
    assert.equal(reopenedReads.length, 2, 'reopening after close must cause exactly one fresh UI-origin read');
    assert.equal(reopenedReads[1].args.origin, 'ui');
    assert.ok(window.document.getElementById('app').textContent.includes('visible text'), 'content must be visible after reopening');
    window.document.getElementById('close-preview-outer').click();
    assert.ok(window.document.querySelector('.lazy-preview-open'), 'second close must return to lightweight card');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 2, 'second close must not add another read');

    const restored = await mount(bundle, window.openai.widgetState);
    try {
      assert.ok(restored.window.document.querySelector('.lazy-preview-open'), 'saved metadata must restore lightweight card');
      assert.equal(restored.window.__dcApp.calls.filter(x => x.name === 'read_file').length, 0, 'reload must not auto-read file');
    } finally { restored.window.close(); }
  } finally {
    await dom.window.__dcApp?.onteardown?.();
    dom.window.close();
  }
}

async function testTeardownDuringPendingRead(bundle) {
  const dom = await mount(bundle, null);
  try {
    const { window } = dom;
    const app = window.__dcApp;
    const onToolInput = app.ontoolinput;
    const onToolResult = app.ontoolresult;
    const onToolCancelled = app.ontoolcancelled;
    onToolInput({ arguments: { path: '/tmp/notes.txt' } });
    onToolResult({ content: [{ type: 'text', text: 'file ready' }] });
    app.deferRead = true;
    window.document.querySelector('.lazy-preview-open').click();
    assert.equal(app.pendingReadResolvers.length, 1, 'user click should start a deferred host read');
    const container = window.document.getElementById('app');
    const stateAtTeardown = JSON.stringify(window.openai.widgetState);

    await app.onteardown();
    const htmlAtTeardown = container.innerHTML;
    assert.equal(htmlAtTeardown, '', 'teardown must detach the rendered preview DOM and its event handlers');
    app.pendingReadResolvers[0]({
      structuredContent: { fileName: 'notes.txt', filePath: '/tmp/notes.txt', fileType: 'text' },
      content: [{ type: 'text', text: 'late host response' }],
    });
    assert.equal(app.ontoolinput, undefined, 'teardown must release the host tool-input callback');
    assert.equal(app.ontoolresult, undefined, 'teardown must release the host tool-result callback');
    assert.equal(app.ontoolcancelled, undefined, 'teardown must release the host cancellation callback');
    onToolInput({ arguments: { path: '/tmp/late.txt' } });
    onToolResult({ content: [{ type: 'text', text: 'late result' }] });
    onToolCancelled({ reason: 'late cancellation' });
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(container.innerHTML, htmlAtTeardown, 'late RPC completion and host notifications must not mutate DOM after teardown');
    assert.equal(JSON.stringify(window.openai.widgetState), stateAtTeardown, 'late callbacks must not persist widget state after teardown');
    assert.ok(!container.textContent.includes('late host response'));
  } finally {
    await dom.window.__dcApp?.onteardown?.();
    dom.window.close();
  }
}

async function testSupersededPendingRead(bundle) {
  const dom = await mount(bundle, null);
  try {
    const { window } = dom;
    const app = window.__dcApp;
    app.ontoolinput({ arguments: { path: '/tmp/race.txt' } });
    app.ontoolresult({ content: [{ type: 'text', text: 'ready' }] });
    app.deferRead = true;

    window.document.querySelector('.lazy-preview-open').click();
    assert.equal(app.pendingReadResolvers.length, 1);
    app.ontoolinput({ arguments: { path: '/tmp/race.txt' } });
    app.ontoolresult({ content: [{ type: 'text', text: 'newer request' }] });
    window.document.querySelector('.lazy-preview-open').click();
    assert.equal(app.pendingReadResolvers.length, 2, 'a new card must be able to read while a superseded request is still pending');

    app.pendingReadResolvers[0]({
      structuredContent: { fileName: 'race.txt', filePath: '/tmp/race.txt', fileType: 'text' },
      content: [{ type: 'text', text: 'stale response' }],
    });
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(!window.document.getElementById('app').textContent.includes('stale response'),
      'superseded response must not render');

    app.pendingReadResolvers[1]({
      structuredContent: { fileName: 'race.txt', filePath: '/tmp/race.txt', fileType: 'text' },
      content: [{ type: 'text', text: 'fresh response' }],
    });
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(window.document.getElementById('app').textContent.includes('fresh response'),
      'latest request must complete and render normally');
  } finally {
    await dom.window.__dcApp?.onteardown?.();
    dom.window.close();
  }
}

async function testFailedPersistenceDoesNotRestoreStaleState(bundle) {
  const stale = createLazyPreviewState({ path: '/tmp/file-a.txt' });
  const dom = await mount(bundle, { payload: stale }, { persistWrites: false });
  try {
    const app = dom.window.__dcApp;
    app.ontoolinput({ arguments: { path: '/tmp/file-b.txt' } });
    assert.equal(dom.window.document.querySelector('.lazy-preview-open')?.title, '/tmp/file-b.txt',
      'new in-memory state should render even when persistence fails');

    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    assert.equal(dom.window.document.querySelector('.lazy-preview-open')?.title, '/tmp/file-b.txt',
      'a stale persisted snapshot must not replace newer in-memory state');
    assert.equal(dom.window.openai.widgetState.payload.readArgs.path, '/tmp/file-a.txt',
      'test fixture should retain the stale persisted snapshot');
  } finally { dom.window.close(); }
}

async function testMarkdownOnDemand(bundle) {
  const dom = await mount(bundle, null);
  try {
    const app = dom.window.__dcApp;
    app.ontoolinput({ arguments: { path: '/tmp/notes.md', length: 3 } });
    app.ontoolresult({ content: [{ type: 'text', text: 'model read completed' }] });
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0, 'Markdown must remain idle until click');
    assert.equal(dom.window.document.getElementById('md-conflict-modal'), null, 'idle Markdown should not mount editor dialog');
    dom.window.document.querySelector('.lazy-preview-open').click();
    for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const reads = app.calls.filter(x => x.name === 'read_file');
    assert.equal(reads.length, 1, 'opening Markdown must not trigger an extra refreshFromDisk read');
    assert.equal(reads[0].args.length, 3, 'Markdown should preserve the original bounded range');
    assert.ok(dom.window.document.getElementById('md-conflict-modal'), 'editor dialog can mount after user interaction');
  } finally { dom.window.close(); }
}

async function testMutationWait(bundle) {
  const dom = await mount(bundle, null);
  try {
    const app = dom.window.__dcApp;
    app.ontoolinput({ arguments: { path: '/tmp/notes.txt', content: 'new file contents' } });
    const pending = dom.window.document.querySelector('.lazy-preview-open');
    assert.ok(pending.disabled, 'write_file preview must stay unavailable until mutation completes');
    assert.equal(app.calls.filter(x => x.name === 'read_file').length, 0);
    app.ontoolresult({ content: [{ type: 'text', text: 'saved' }] });
    const ready = dom.window.document.querySelector('.lazy-preview-open');
    assert.ok(!ready.disabled, 'successful mutation enables on-demand preview');
    ready.click();
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const calls = app.calls.filter(x => x.name === 'read_file');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.origin, 'ui');
  } finally { dom.window.close(); }
}

async function testLegacyMigration(bundle) {
  const legacy = { payload: { filePath: '/tmp/notes.txt', fileName: 'notes.txt', fileType: 'text', content: 'X'.repeat(300000) } };
  const dom = await mount(bundle, legacy);
  try {
    assert.ok(dom.window.document.querySelector('.lazy-preview-open'));
    assert.ok(isLazyPreviewState(dom.window.openai.widgetState.payload));
    assert.ok(JSON.stringify(dom.window.openai.widgetState).length < 500);
    assert.equal(dom.window.__dcApp.calls.filter(x => x.name === 'read_file').length, 0);
  } finally { dom.window.close(); }
}

export default async function runTests() {
  await testBoundsAndMetadata();
  await testLightShellTeardown();
  const bundle = await buildPreviewHarness();
  await testOnDemandRuntime(bundle);
  await testTeardownDuringPendingRead(bundle);
  await testSupersededPendingRead(bundle);
  await testFailedPersistenceDoesNotRestoreStaleState(bundle);
  await testMarkdownOnDemand(bundle);
  await testMutationWait(bundle);
  await testLegacyMigration(bundle);
  console.log('PASS: file preview lazy card, single user-initiated read, unload, same-DOM reopen, reload, legacy migration');
  return true;
}

runIfMain(import.meta.url, runTests);
