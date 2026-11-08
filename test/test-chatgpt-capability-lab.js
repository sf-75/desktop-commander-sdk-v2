import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { startServerLikeRemote } from './helpers/mcp-server.js';

const LAB_TOOL = 'sdk_v2_chatgpt_capability_lab';
const ECHO_TOOL = 'sdk_v2_chatgpt_capability_lab_echo';
const REPORT_TOOL = 'sdk_v2_chatgpt_capability_lab_report_v6';
const FILE_TOOL = 'sdk_v2_chatgpt_file_param_probe';
const LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v9';
const PREVIOUS_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v8';
const V7_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v7';
const V6_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v6';
const OLDER_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v5';
const V4_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v4';
const V3_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v3';
const V2_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v2';
const LEGACY_LAB_RESOURCE = 'ui://desktop-commander/chatgpt-capability-lab-v1';

async function snapshot(enabled) {
  const server = await startServerLikeRemote({
    ...process.env,
    DC_SDK_V2_PLAYGROUND: enabled ? '1' : '0',
    DC_SDK_V2_EXPERIMENTAL_MRTR: '0',
  });
  try {
    const [tools, resources] = await Promise.all([
      server.client.listTools(),
      server.client.listResources(),
    ]);
    return { server, tools: tools.tools, resources: resources.resources };
  } catch (error) {
    await server.close();
    throw error;
  }
}

function toolNames(items) {
  return items.map(item => item.name).sort();
}

function resourceUris(items) {
  return items.map(item => item.uri).sort();
}

const off = await snapshot(false);
const on = await snapshot(true);

try {
  for (const toolName of [LAB_TOOL, ECHO_TOOL, REPORT_TOOL, FILE_TOOL]) {
    assert.equal(off.tools.some(tool => tool.name === toolName), false, `${toolName} must be absent when playground is off`);
  }
  assert.equal(off.resources.some(resource => resource.uri === LAB_RESOURCE), false, 'lab resource must be absent when playground is off');
  for (const legacyUri of [PREVIOUS_LAB_RESOURCE, V7_LAB_RESOURCE, V6_LAB_RESOURCE, OLDER_LAB_RESOURCE, V4_LAB_RESOURCE, V3_LAB_RESOURCE, V2_LAB_RESOURCE, LEGACY_LAB_RESOURCE]) {
    assert.equal(off.resources.some(resource => resource.uri === legacyUri), false, 'legacy lab resource must be absent from the default profile');
  }

  const labTool = on.tools.find(tool => tool.name === LAB_TOOL);
  const echoTool = on.tools.find(tool => tool.name === ECHO_TOOL);
  const reportTool = on.tools.find(tool => tool.name === REPORT_TOOL);
  const fileTool = on.tools.find(tool => tool.name === FILE_TOOL);
  assert.ok(labTool, 'lab model tool must be present when playground is on');
  assert.ok(echoTool, 'lab app-only tool must be present when playground is on');
  assert.ok(reportTool, 'lab report app-only tool must be present when playground is on');
  assert.ok(fileTool, 'file-param probe must be present when playground is on');
  assert.equal(labTool?._meta?.ui?.resourceUri, LAB_RESOURCE);
  assert.equal(labTool?._meta?.['openai/toolInvocation/invoking'], 'Opening capability lab…');
  assert.equal(labTool?._meta?.['openai/toolInvocation/invoked'], 'Capability lab ready');
  assert.ok(labTool?.outputSchema, 'lab structuredContent must declare outputSchema');
  assert.deepEqual(echoTool?._meta?.ui?.visibility, ['app']);
  assert.ok(echoTool?.outputSchema, 'echo structuredContent must declare outputSchema');
  assert.deepEqual(reportTool?._meta?.ui?.visibility, ['app']);
  assert.ok(reportTool?.outputSchema, 'report structuredContent must declare outputSchema');
  assert.deepEqual(reportTool?.inputSchema?.properties?.labBuildVersion?.enum, [6]);
  assert.deepEqual(reportTool?.inputSchema?.properties?.labResourceUri?.enum, ['ui://desktop-commander/chatgpt-capability-lab-v6']);
  assert.equal(reportTool?.inputSchema?.properties?.layoutDiagnostics?.type, 'object');
  assert.deepEqual(fileTool?._meta?.['openai/fileParams'], ['file']);
  assert.deepEqual(fileTool?.inputSchema?.$defs?.OpenAIFile?.required, ['download_url', 'file_id']);
  assert.equal(fileTool?.inputSchema?.properties?.file?.$ref, '#/$defs/OpenAIFile');
  assert.ok(fileTool?.outputSchema, 'file probe structuredContent must declare outputSchema');
  assert.ok(on.resources.some(resource => resource.uri === LAB_RESOURCE), 'lab resource must be present when playground is on');
  for (const legacyUri of [PREVIOUS_LAB_RESOURCE, V7_LAB_RESOURCE, V6_LAB_RESOURCE, OLDER_LAB_RESOURCE, V4_LAB_RESOURCE, V3_LAB_RESOURCE, V2_LAB_RESOURCE, LEGACY_LAB_RESOURCE]) {
    assert.equal(on.resources.some(resource => resource.uri === legacyUri), false, 'legacy resource URI must remain read-compatible but not advertised');
  }

  const addedTools = toolNames(on.tools).filter(name => !toolNames(off.tools).includes(name));
  const addedResources = resourceUris(on.resources).filter(uri => !resourceUris(off.resources).includes(uri));
  assert.deepEqual(addedTools, [LAB_TOOL, ECHO_TOOL, REPORT_TOOL, FILE_TOOL].sort(), 'playground flag should add only the four lab/probe tools');
  assert.deepEqual(addedResources, [LAB_RESOURCE], 'playground flag should add only the lab resource');

  for (const legacyUri of [PREVIOUS_LAB_RESOURCE, V7_LAB_RESOURCE, V6_LAB_RESOURCE, OLDER_LAB_RESOURCE, V4_LAB_RESOURCE, V3_LAB_RESOURCE, V2_LAB_RESOURCE, LEGACY_LAB_RESOURCE]) {
    const legacyResource = await on.server.client.readResource({ uri: legacyUri });
    assert.equal(legacyResource.contents?.[0]?.uri, legacyUri);
    assert.ok(legacyResource.contents?.[0]?.text?.includes('data-tab="basic"'), 'legacy URI must serve the updated tabbed UI');
    assert.ok(legacyResource.contents?.[0]?.text?.includes('labBuildVersion:9'), 'legacy URI must serve the current v9 UI bundle');
    if (legacyUri === PREVIOUS_LAB_RESOURCE) {
      assert.equal(legacyResource.ttlMs, 60_000, 'the cached v8 alias must carry a short cache hint');
      assert.equal(legacyResource.cacheScope, 'private');
    }
  }

  const resource = await on.server.client.readResource({ uri: LAB_RESOURCE });
  const html = resource.contents?.[0]?.text ?? '';
  const uiSource = await readFile(new URL('../src/ui/chatgpt-capability-lab/src/main.ts', import.meta.url), 'utf8');
  const listenerRegistrations = uiSource.match(/\.addEventListener\(/g) ?? [];
  const lifecycleRegistrations = uiSource.match(/signal: lifecycle\.signal \}\);/g) ?? [];
  assert.equal(lifecycleRegistrations.length, listenerRegistrations.length, 'every DOM/window listener must be bound to the lab lifecycle signal');
  assert.match(uiSource, /const disposeLab = \(\): void => \{[\s\S]*?lifecycle\.abort\(\)[\s\S]*?state = \{ counter: 0, lastAction: 'disposed', selectedFiles: \[\] \}[\s\S]*?uploadInput\.value = ''[\s\S]*?bridge\.dispose\(\)/, 'resource teardown must abort listeners, release file metadata/credentials, clear the file input, and dispose the shared bridge');
  assert.match(uiSource, /pendingHeightFrame = window\.requestAnimationFrame/);
  assert.match(uiSource, /app\.callServerTool\([\s\S]*?signal: lifecycle\.signal/);
  assert.match(uiSource, /app\.listServerResources\(undefined, \{ signal: lifecycle\.signal, \}\)/);
  assert.match(uiSource, /window\.cancelAnimationFrame\(pendingHeightFrame\)/);
  assert.match(uiSource, /delete report\.labBuildVersion[\s\S]*?delete report\.labResourceUri[\s\S]*?callLabServerTool\(REPORT_TOOL, report\)/, 'automatic report must use the SDK callServerTool path with the cached v6 schema');
  assert.match(uiSource, /void app\.connect\(\)\.then\(async \(\) => \{[\s\S]*?callLabServerTool\(ECHO_TOOL/, 'boot echo must run only after the host handshake');
  for (const tab of ['basic', 'files', 'display', 'apis', 'environment']) {
    assert.ok(html.includes(`data-tab="${tab}"`), `capability lab tab ${tab} must be present`);
    assert.ok(html.includes(`data-panel="${tab}"`), `capability lab panel ${tab} must be present`);
  }
  assert.ok(html.includes('id="panel-scroll"'), 'capability lab must provide an internal scroll region');
  assert.ok(html.includes('id="probe-file-param"'), 'Files panel must expose the file-param probe action');
  assert.ok(html.includes('id="file-probe-status"'), 'Files panel must expose a probe result status');
  assert.match(uiSource, /const FILE_PARAM_PROBE_TOOL = 'sdk_v2_chatgpt_file_param_probe'/);
  assert.match(uiSource, /callLabServerTool\(FILE_PARAM_PROBE_TOOL, \{ file: fileParam \}\)/, 'Files panel must send the acquired file object through SDK callServerTool');
  assert.match(uiSource, /delete persistedState\.downloadUrl/, 'presigned download URLs must not be persisted in widget state');
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const tabs = [...document.querySelectorAll('[role="tab"][data-tab]')];
  assert.deepEqual(tabs.map(tab => tab.getAttribute('data-tab')), ['basic', 'files', 'display', 'apis', 'environment']);
  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    assert.ok(panel, `tab ${tab.id} must reference an existing panel`);
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
    assert.equal(panel.hidden, tab.dataset.tab !== 'basic', `only the Basic panel should start visible`);
  }
  const basicPanelMarkup = document.getElementById('panel-basic');
  assert.ok(basicPanelMarkup && basicPanelMarkup.childElementCount > 0, 'Basic panel must contain rendered sections');
  assert.ok((basicPanelMarkup?.textContent ?? '').trim().length > 0, 'Basic panel must contain visible text content');
  const css = await readFile(new URL('../src/ui/styles/apps/chatgpt-capability-lab.css', import.meta.url), 'utf8');
  const cardCss = css.match(/\.lab-card\s*\{([^}]*)\}/s)?.[1] ?? '';
  const scrollCss = css.match(/\.lab-panel-scroll\s*\{([^}]*)\}/s)?.[1] ?? '';
  assert.match(cardCss, /height:\s*min\(760px/);
  assert.match(scrollCss, /min-height:\s*0;/);
  assert.match(scrollCss, /overflow-y:\s*auto;/);
  dom.window.close();

  const interactionDom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://capability-lab.test/',
  });
  const interactionWindow = interactionDom.window;
  interactionWindow.MessageChannel = globalThis.MessageChannel;
  interactionWindow.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const uiServerToolCalls = [];
  const uiRequests = [];
  let deferNextResourcesList = false;
  let deferredResourcesListId;
  const uiNotifications = [];
  const persistedWidgetStates = [];
  const hostApiCalls = [];
  const uiFile = { fileId: 'file_ui_e2e_probe', fileName: 'ui-e2e.png', mimeType: 'image/png' };
  const uiDownloadUrl = 'https://files.invalid/ui-e2e-temporary-download-token';
  const sendHostResponse = (id, result, error) => {
    const data = { jsonrpc: '2.0', id };
    if (error) data.error = error;
    else data.result = result;
    interactionWindow.dispatchEvent(new interactionWindow.MessageEvent('message', {
      data,
      source: interactionWindow.parent,
      origin: 'http://capability-lab.test',
    }));
  };
  interactionWindow.parent.postMessage = (message) => {
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method === 'ui/initialize') {
      queueMicrotask(() => sendHostResponse(message.id, {
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'test-host', version: '1.0.0' },
        hostCapabilities: {
          serverTools: {},
          serverResources: {},
          openLinks: {},
          logging: {},
          sandbox: {},
          updateModelContext: { text: {}, structuredContent: {} },
          message: { text: {} },
        },
        hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] },
      }));
      return;
    }
    if (message.method === 'tools/call') {
      const params = message.params ?? {};
      uiServerToolCalls.push(params);
      void on.server.client.callTool({
        name: params.name,
        arguments: params.arguments ?? {},
      }).then(
        result => sendHostResponse(message.id, result),
        error => sendHostResponse(message.id, undefined, { code: -32000, message: String(error) }),
      );
      return;
    }
    if (message.id !== undefined) {
      const params = message.params ?? {};
      uiRequests.push({ method: message.method, params });
      if (message.method === 'resources/list') {
        if (deferNextResourcesList) {
          deferNextResourcesList = false;
          deferredResourcesListId = message.id;
          return;
        }
        void on.server.client.listResources().then(
          result => sendHostResponse(message.id, result),
          error => sendHostResponse(message.id, undefined, { code: -32000, message: String(error) }),
        );
        return;
      }
      if (message.method === 'resources/read') {
        void on.server.client.readResource({ uri: params.uri }).then(
          result => sendHostResponse(message.id, result),
          error => sendHostResponse(message.id, undefined, { code: -32000, message: String(error) }),
        );
        return;
      }
      if (message.method === 'ui/request-display-mode') {
        sendHostResponse(message.id, { mode: params.mode });
        return;
      }
      if (message.method === 'ui/download-file') {
        sendHostResponse(message.id, { isError: true });
        return;
      }
      sendHostResponse(message.id, {});
      return;
    }
    uiNotifications.push({ method: message.method, params: message.params ?? {} });
  };
  interactionWindow.openai = {
    widgetState: {},
    setWidgetState: value => persistedWidgetStates.push(value),
    callTool: async (name, args) => {
      hostApiCalls.push({ method: 'callTool', name, args });
      return { structuredContent: { echo: args.message } };
    },
    sendFollowUpMessage: async args => {
      hostApiCalls.push({ method: 'sendFollowUpMessage', args });
      return {};
    },
    uploadFile: async (file, options) => {
      hostApiCalls.push({ method: 'uploadFile', fileName: file.name, mimeType: file.type, library: options?.library });
      return { fileId: 'file_ui_uploaded' };
    },
    selectFiles: async () => [uiFile],
    getFileDownloadUrl: async ({ fileId }) => {
      hostApiCalls.push({ method: 'getFileDownloadUrl', fileId });
      assert.ok([uiFile.fileId, 'file_ui_uploaded'].includes(fileId), 'getFileDownloadUrl must use a selected or uploaded file ID');
      return { downloadUrl: uiDownloadUrl };
    },
    requestDisplayMode: async args => {
      hostApiCalls.push({ method: 'requestDisplayMode', args });
      return { mode: args.mode };
    },
    requestModal: async args => {
      hostApiCalls.push({ method: 'requestModal', args });
      return {};
    },
    requestClose: async () => {
      hostApiCalls.push({ method: 'requestClose' });
      return {};
    },
    openExternal: async args => {
      hostApiCalls.push({ method: 'openExternal', args });
      return {};
    },
    setOpenInAppUrl: async args => {
      hostApiCalls.push({ method: 'setOpenInAppUrl', args });
      return {};
    },
    getHostCapabilities: () => ({}),
    getHostVersion: () => ({ name: 'test', version: '1' }),
    getHostContext: () => ({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] }),
  };
  const inlineRuntime = interactionWindow.document.querySelector('script')?.textContent ?? '';
  assert.ok(inlineRuntime.length > 1000, 'inlined capability lab runtime must be present');
  interactionWindow.eval(inlineRuntime);
  assert.equal(interactionWindow.document.body.classList.contains('dc-ready'), true, 'Capability Lab must release the shared 32px pre-ready body clamp');
  const interactionTabs = [...interactionWindow.document.querySelectorAll('[role="tab"][data-tab]')];
  const tab = name => interactionTabs.find(item => item.dataset.tab === name);
  const panel = name => interactionWindow.document.querySelector('[role="tabpanel"][data-panel="' + name + '"]');
  const basicTab = tab('basic');
  const filesTab = tab('files');
  const displayTab = tab('display');
  const environmentTab = tab('environment');
  filesTab.click();
  assert.equal(filesTab.getAttribute('aria-selected'), 'true');
  assert.equal(filesTab.tabIndex, 0);
  assert.equal(panel('files').hidden, false);
  assert.equal(panel('basic').hidden, true);
  filesTab.dispatchEvent(new interactionWindow.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  assert.equal(displayTab.getAttribute('aria-selected'), 'true', 'ArrowRight should advance to Display');
  displayTab.dispatchEvent(new interactionWindow.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.equal(filesTab.getAttribute('aria-selected'), 'true', 'ArrowLeft should return to Files');
  basicTab.dispatchEvent(new interactionWindow.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.equal(environmentTab.getAttribute('aria-selected'), 'true', 'ArrowLeft should wrap to Environment');
  environmentTab.dispatchEvent(new interactionWindow.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  assert.equal(basicTab.getAttribute('aria-selected'), 'true', 'ArrowRight should wrap to Basic');
  const scrollRegion = interactionWindow.document.getElementById('panel-scroll');
  scrollRegion.scrollTop = 123;
  assert.equal(scrollRegion.scrollTop, 123, 'scrollTop test fixture should be settable');
  filesTab.click();
  assert.equal(scrollRegion.scrollTop, 0, 'tab changes should reset internal scroll');

  const waitForUi = async (predicate, label) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Timed out waiting for ' + label + ' (status=' + interactionWindow.document.getElementById('lab-status').textContent + ')');
  };
  await waitForUi(() => uiServerToolCalls.some(call => call.name === ECHO_TOOL), 'MCP Apps boot echo');
  await waitForUi(() => uiServerToolCalls.some(call => call.name === REPORT_TOOL), 'MCP Apps capability report');

  interactionWindow.document.getElementById('select-files').click();
  await waitForUi(
    () => interactionWindow.document.getElementById('file-status').textContent.includes(uiFile.fileName),
    'selected file render',
  );
  interactionWindow.document.getElementById('probe-file-param').click();
  await waitForUi(
    () => interactionWindow.document.getElementById('file-probe-status').textContent.includes('received ' + uiFile.fileName),
    'file param probe response',
  );

  const uiFileCall = uiServerToolCalls.findLast(call => call.name === FILE_TOOL);
  assert.ok(uiFileCall, 'Files probe button must issue a tools/call request through the MCP Apps SDK');
  assert.deepEqual(JSON.parse(JSON.stringify(uiFileCall.arguments.file)), {
    download_url: uiDownloadUrl,
    file_id: uiFile.fileId,
    mime_type: uiFile.mimeType,
    file_name: uiFile.fileName,
  }, 'MCP server must receive the selected file metadata and temporary download URL');
  assert.match(
    interactionWindow.document.getElementById('lab-status').textContent,
    /file param probe: ok/,
    'Files probe button must render the successful result',
  );
  assert.ok(persistedWidgetStates.length > 0, 'widget state should be persisted during the UI flow');
  assert.equal(
    JSON.stringify(persistedWidgetStates).includes(uiDownloadUrl),
    false,
    'temporary download URLs must never enter persisted widget state',
  );

  interactionWindow.document.getElementById('state-inc').click();
  assert.equal(persistedWidgetStates.at(-1)?.privateContent?.labState?.counter, 1, 'state increment must persist the updated widget state');

  interactionWindow.document.getElementById('context-update').click();
  await waitForUi(() => uiRequests.some(request => request.method === 'ui/update-model-context'), 'model context update');
  const modelContextRequest = uiRequests.findLast(request => request.method === 'ui/update-model-context');
  assert.equal(modelContextRequest.params.structuredContent.counter, 1, 'model context must contain the current counter');
  assert.match(modelContextRequest.params.content?.[0]?.text ?? '', /counter=1/, 'model context text must contain the current counter');

  interactionWindow.document.getElementById('follow-up').click();
  await waitForUi(() => hostApiCalls.some(call => call.method === 'sendFollowUpMessage'), 'follow-up message');
  const followUpCall = hostApiCalls.findLast(call => call.method === 'sendFollowUpMessage');
  assert.equal(followUpCall.args.scrollToBottom, true);
  assert.match(followUpCall.args.prompt, /Capability Lab/);

  interactionWindow.document.getElementById('call-tool').click();
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('window.openai.callTool: ok'), 'host callTool action');
  const hostToolCall = hostApiCalls.findLast(call => call.method === 'callTool');
  assert.equal(hostToolCall.name, ECHO_TOOL);
  assert.equal(hostToolCall.args.message, 'counter=1');

  interactionWindow.document.getElementById('std-call-tool').click();
  await waitForUi(() => uiServerToolCalls.some(call => call.name === ECHO_TOOL && call.arguments?.message === 'standard-counter=1'), 'standard callServerTool action');
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('app.callServerTool: ok'), 'standard callServerTool result');

  interactionWindow.document.getElementById('std-list-resources').click();
  await waitForUi(() => uiRequests.some(request => request.method === 'resources/list'), 'standard resources/list');
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('app.listServerResources: ok'), 'standard listServerResources result');
  interactionWindow.document.getElementById('std-read-resource').click();
  await waitForUi(() => uiRequests.some(request => request.method === 'resources/read'), 'standard resources/read');
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('app.readServerResource: ok'), 'standard readServerResource result');

  interactionWindow.document.getElementById('std-message').click();
  await waitForUi(() => uiRequests.some(request => request.method === 'ui/message'), 'standard ui/message');
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('app.sendMessage: ok'), 'standard sendMessage result');

  interactionWindow.document.getElementById('std-log').click();
  await waitForUi(() => uiNotifications.some(notification => notification.method === 'notifications/message'), 'standard logging notification');
  interactionWindow.document.getElementById('std-open-link').click();
  await waitForUi(() => uiRequests.some(request => request.method === 'ui/open-link'), 'standard open-link request');
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('app.openLink: ok'), 'standard openLink result');

  interactionWindow.document.getElementById('std-download').click();
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('app.downloadFile: host rejected download'), 'unsupported standard download result');

  interactionWindow.document.getElementById('std-display').click();
  await waitForUi(() => uiRequests.some(request => request.method === 'ui/request-display-mode'), 'standard display-mode request');
  assert.equal(uiRequests.findLast(request => request.method === 'ui/request-display-mode').params.mode, 'fullscreen');


  interactionWindow.document.getElementById('std-tool-list-changed').click();
  await waitForUi(() => uiNotifications.some(notification => notification.method === 'notifications/tools/list_changed'), 'standard tool-list-changed notification');
  interactionWindow.document.getElementById('std-teardown').click();
  await waitForUi(() => uiNotifications.some(notification => notification.method === 'ui/notifications/request-teardown'), 'standard request-teardown notification');

  interactionWindow.document.querySelector('[data-mode="fullscreen"]').click();
  await waitForUi(() => hostApiCalls.some(call => call.method === 'requestDisplayMode' && call.args?.mode === 'fullscreen'), 'host display-mode helper');

  interactionWindow.document.getElementById('modal').click();
  await waitForUi(() => hostApiCalls.some(call => call.method === 'requestModal'), 'host modal helper');
  const modalCall = hostApiCalls.findLast(call => call.method === 'requestModal');
  assert.equal(modalCall.args.title, 'Capability Lab');
  assert.equal(modalCall.args.template, LAB_RESOURCE);

  interactionWindow.document.getElementById('height').click();
  await waitForUi(() => interactionWindow.document.getElementById('lab-status').textContent.includes('notifyIntrinsicHeight unsupported'), 'unsupported intrinsic-height helper');

  interactionWindow.document.getElementById('close').click();
  await waitForUi(() => hostApiCalls.some(call => call.method === 'requestClose'), 'host requestClose helper');
  interactionWindow.document.getElementById('open-docs').click();
  await waitForUi(() => hostApiCalls.some(call => call.method === 'openExternal'), 'host openExternal helper');
  interactionWindow.document.getElementById('set-open-url').click();
  await waitForUi(() => hostApiCalls.some(call => call.method === 'setOpenInAppUrl'), 'host setOpenInAppUrl helper');

  interactionWindow.document.getElementById('nav-detail').click();
  assert.equal(interactionWindow.location.search, '?source=capability-lab', 'navigation detail should update the in-app URL');
  interactionWindow.document.getElementById('nav-back').click();
  await waitForUi(() => interactionWindow.location.search === '', 'navigation history back');

  filesTab.click();
  const uploadInput = interactionWindow.document.getElementById('upload-input');
  const uploadedFile = new interactionWindow.File(['synthetic upload'], 'uploaded.txt', { type: 'text/plain' });
  Object.defineProperty(uploadInput, 'files', { configurable: true, value: [uploadedFile] });
  interactionWindow.document.getElementById('upload-library').checked = true;
  uploadInput.dispatchEvent(new interactionWindow.Event('change', { bubbles: true }));
  await waitForUi(() => hostApiCalls.some(call => call.method === 'uploadFile'), 'uploadFile action');
  await waitForUi(() => interactionWindow.document.getElementById('file-status').textContent.includes('uploaded: file_ui_uploaded'), 'uploaded file state render');
  const uploadCall = hostApiCalls.findLast(call => call.method === 'uploadFile');
  assert.deepEqual(
    { fileName: uploadCall.fileName, mimeType: uploadCall.mimeType, library: uploadCall.library },
    { fileName: 'uploaded.txt', mimeType: 'text/plain', library: true },
    'uploadFile must receive the selected file and Library option',
  );

  interactionWindow.document.getElementById('download-url').click();
  await waitForUi(
    () => interactionWindow.document.getElementById('file-status').textContent.includes('download URL: acquired'),
    'uploaded file download URL',
  );
  assert.equal(hostApiCalls.findLast(call => call.method === 'getFileDownloadUrl').fileId, 'file_ui_uploaded');

  interactionWindow.document.getElementById('probe-file-param').click();
  await waitForUi(
    () => interactionWindow.document.getElementById('file-probe-status').textContent.includes('received uploaded.txt'),
    'uploaded file MCP file-param response',
  );
  const uploadedFileCall = uiServerToolCalls.findLast(call => call.name === FILE_TOOL);
  assert.deepEqual(JSON.parse(JSON.stringify(uploadedFileCall.arguments.file)), {
    download_url: uiDownloadUrl,
    file_id: 'file_ui_uploaded',
    mime_type: 'text/plain',
    file_name: 'uploaded.txt',
  }, 'uploaded file metadata and download URL must reach the MCP server');

  assert.equal(
    JSON.stringify(persistedWidgetStates).includes(uiDownloadUrl),
    false,
    'temporary download URLs must never enter persisted widget state after upload either',
  );
  const uiHistory = await on.server.client.callTool({
    name: 'get_recent_tool_calls',
    arguments: { maxResults: 10, toolName: FILE_TOOL },
  });
  assert.equal(JSON.stringify(uiHistory).includes(uiDownloadUrl), false, 'UI file probe history must redact temporary download URL');
  assert.ok(JSON.stringify(uiHistory).includes('[redacted]'), 'UI file probe history must preserve an explicit redaction marker');

  deferNextResourcesList = true;
  interactionWindow.document.getElementById('std-list-resources').click();
  await waitForUi(() => deferredResourcesListId !== undefined, 'pending resources/list request before teardown');
  const stateBeforeResourceTeardown = interactionWindow.document.getElementById('state-value').textContent;
  const statusBeforeResourceTeardown = interactionWindow.document.getElementById('lab-status').textContent;
  const persistedCountBeforeResourceTeardown = persistedWidgetStates.length;
  interactionWindow.dispatchEvent(new interactionWindow.MessageEvent('message', {
    data: { jsonrpc: '2.0', id: 9001, method: 'ui/resource-teardown', params: {} },
    source: interactionWindow.parent,
    origin: 'http://capability-lab.test',
  }));
  await waitForUi(() => persistedWidgetStates.length > persistedCountBeforeResourceTeardown, 'host resource teardown state persistence');
  await waitForUi(() => uiNotifications.some(notification => notification.method === 'notifications/cancelled' && notification.params?.requestId === deferredResourcesListId), 'lifecycle abort cancellation of pending App RPC');
  assert.equal(interactionWindow.document.getElementById('file-status').textContent, 'selected: none', 'resource teardown must release selected/uploaded file metadata and temporary download URL');
  assert.equal(interactionWindow.document.getElementById('upload-input').value, '', 'resource teardown must clear the native file input');
  sendHostResponse(deferredResourcesListId, { resources: [{ uri: 'ui://late-resource-after-teardown' }] });
  interactionWindow.document.getElementById('state-inc').click();
  interactionWindow.document.getElementById('nav-detail').click();
  assert.equal(interactionWindow.document.getElementById('state-value').textContent, stateBeforeResourceTeardown, 'resource teardown must remove DOM listeners');
  assert.equal(interactionWindow.document.getElementById('lab-status').textContent, statusBeforeResourceTeardown, 'resource teardown must prevent late status updates');
  assert.equal(interactionWindow.location.search, '', 'resource teardown must remove navigation listeners');
  assert.equal(persistedWidgetStates.length, persistedCountBeforeResourceTeardown + 1, 'post-teardown clicks must not persist widget state');
  interactionDom.window.close();

  for (const apiName of [
    'setWidgetState', 'sendFollowUpMessage', 'uploadFile', 'selectFiles', 'getFileDownloadUrl',
    'requestDisplayMode', 'requestModal', 'requestClose', 'notifyIntrinsicHeight', 'openExternal', 'setOpenInAppUrl',
    'requestCheckout', 'callServerTool', 'listServerResources', 'readServerResource', 'sendMessage', 'sendLog',
    'openLink', 'downloadFile', 'sendSizeChanged', 'sendToolListChanged', 'createSamplingMessage', 'requestTeardown', 'history.pushState',
  ]) {
    assert.ok(html.includes(apiName), `inlined capability lab must include ${apiName}`);
  }
  assert.deepEqual(resource.contents?.[0]?._meta?.['openai/ui']?.availableDisplayModes, ['inline', 'fullscreen', 'pip']);
  assert.equal(resource.contents?.[0]?._meta?.ui?.prefersBorder, true);

  const lab = await on.server.client.callTool({ name: LAB_TOOL, arguments: {} });
  assert.equal(lab.isError, undefined);
  assert.equal(lab.structuredContent?.status, 'ready');
  assert.equal(lab.structuredContent?.version, 9);
  assert.equal(lab._meta?.capabilityLabPrivateMarker, 'widget-only-v9');

  const echo = await on.server.client.callTool({
    name: ECHO_TOOL,
    arguments: { origin: 'ui', message: 'contract-smoke' },
  });
  assert.equal(echo.isError, undefined);
  assert.equal(echo.structuredContent?.echo, 'contract-smoke');

  const denied = await on.server.client.callTool({
    name: ECHO_TOOL,
    arguments: { origin: 'llm', message: 'must-not-pass' },
  });
  assert.equal(denied.isError, true, 'app-only echo must reject non-ui origin');

  const report = await on.server.client.callTool({
    name: REPORT_TOOL,
    arguments: {
      origin: 'ui',
      labBuildVersion: 6,
      labResourceUri: 'ui://desktop-commander/chatgpt-capability-lab-v6',
      windowMethods: ['setWidgetState', 'callTool'],
      hostCapabilityKeys: ['serverTools', 'openLinks'],
      hostName: 'test-host',
      hostVersion: '1',
      displayMode: 'inline',
      layoutDiagnostics: {
        bodyClassName: 'dc-ready', bodyMaxHeight: 'none', bodyHeight: 800, bodyScrollHeight: 800,
        bodyBackgroundColor: 'rgb(255, 255, 255)', bodyColor: 'rgb(30, 30, 30)',
        bodyVisibility: 'visible', bodyOpacity: '1',
        documentElementClientHeight: 800, documentElementScrollHeight: 800, windowInnerHeight: 800,
        cardHeight: 760, cardDisplay: 'block', cardVisibility: 'visible', cardOpacity: '1',
        cardBackgroundColor: 'rgb(255, 255, 255)', cardColor: 'rgb(30, 30, 30)',
        headerHeight: 80, tabsHeight: 40, basicPanelHeight: 500, basicPanelDisplay: 'block',
        basicPanelVisibility: 'visible', basicPanelOpacity: '1',
        basicPanelBackgroundColor: 'rgba(0, 0, 0, 0)', basicPanelColor: 'rgb(30, 30, 30)',
        basicPanelTextLength: 120, basicPanelChildCount: 3, basicPanelFirstChildTag: 'DIV',
        basicPanelFirstChildHeight: 100, basicPanelFirstChildDisplay: 'block',
        basicPanelHidden: false, scrollRegionClientHeight: 500, scrollRegionScrollHeight: 620,
        scrollRegionOverflowY: 'auto', readyState: 'complete',
      },
      availableDisplayModes: ['inline', 'fullscreen'],
    },
  });
  assert.equal(report.isError, undefined);
  assert.deepEqual(report.structuredContent, { status: 'recorded', windowMethodCount: 2, hostCapabilityCount: 2 });

  const diagnosticConfig = await on.server.client.callTool({
    name: 'get_config',
    arguments: {},
    _meta: { progressToken: 123, capabilityLabProbeSecret: 'must-not-be-captured' },
  });
  const diagnostics = diagnosticConfig.structuredContent?.playgroundDiagnostics;
  assert.ok(diagnostics, 'playground diagnostics must be exposed through get_config');
  assert.equal(diagnostics.capabilityReportCount, 2, 'one automatic UI report plus one explicit contract report');
  assert.equal(diagnostics.lastResourceReadUri, LAB_RESOURCE);
  assert.equal(diagnostics.lastCapabilityReport?.labBuildVersion, 6);
  assert.equal(diagnostics.lastCapabilityReport?.labResourceUri, 'ui://desktop-commander/chatgpt-capability-lab-v6');
  assert.deepEqual(diagnostics.lastCapabilityReport?.windowMethods, ['setWidgetState', 'callTool']);
  assert.deepEqual(diagnostics.lastCapabilityReport?.hostCapabilityKeys, ['serverTools', 'openLinks']);
  assert.equal(diagnostics.lastCapabilityReport?.displayMode, 'inline');
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.bodyClassName, 'dc-ready');
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.bodyMaxHeight, 'none');
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.basicPanelHidden, false);
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.bodyColor, 'rgb(30, 30, 30)');
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.basicPanelTextLength, 120);
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.basicPanelChildCount, 3);
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.bodyBackgroundColor, 'rgb(255, 255, 255)');
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.basicPanelVisibility, 'visible');
  assert.equal(diagnostics.lastCapabilityReport?.layoutDiagnostics?.scrollRegionOverflowY, 'auto');
  assert.equal(diagnostics.lastToolRequestName, 'get_config');
  assert.deepEqual(diagnostics.lastToolRequestMetaKeys, ['capabilityLabProbeSecret', 'progressToken']);
  assert.equal(diagnostics.lastToolRequestProgressTokenPresent, true);
  assert.equal(diagnostics.lastToolRequestProgressTokenType, 'number');
  assert.equal(JSON.stringify(diagnostics).includes('must-not-be-captured'), false, 'request _meta values must never be captured');
  assert.equal(typeof diagnostics.negotiatedProtocolVersion, 'string');
  assert.equal(diagnostics.clientVersion?.name, 'desktop-commander-client');
  assert.ok(Array.isArray(diagnostics.clientCapabilities?.topLevelKeys));

  const deniedReport = await on.server.client.callTool({
    name: REPORT_TOOL,
    arguments: { windowMethods: [], hostCapabilityKeys: [] },
  });
  assert.equal(deniedReport.isError, true, 'app-only report must reject non-ui origin');

  const secretUrl = 'https://secret.invalid/token-should-never-enter-history';
  const fileProbe = await on.server.client.callTool({
    name: FILE_TOOL,
    arguments: {
      file: {
        download_url: secretUrl,
        file_id: 'file_capability_lab_probe',
        mime_type: 'text/plain',
        file_name: 'probe.txt',
      },
    },
  });
  assert.equal(fileProbe.isError, undefined);
  assert.deepEqual(fileProbe.structuredContent, {
    fileId: 'file_capability_lab_probe',
    fileName: 'probe.txt',
    mimeType: 'text/plain',
    hasDownloadUrl: true,
  });
  assert.equal(JSON.stringify(fileProbe).includes(secretUrl), false, 'file probe result must not expose temporary download URL');

  const history = await on.server.client.callTool({
    name: 'get_recent_tool_calls',
    arguments: { maxResults: 10, toolName: FILE_TOOL },
  });
  assert.equal(JSON.stringify(history).includes(secretUrl), false, 'file probe history must redact temporary download URL');
  assert.ok(JSON.stringify(history).includes('[redacted]'), 'file probe history should preserve an explicit redaction marker');

  console.log('PASS ChatGPT capability lab contract');
  console.log(`OFF ${off.tools.length} tools / ${off.resources.length} resources`);
  console.log(`ON  ${on.tools.length} tools / ${on.resources.length} resources`);
} finally {
  await Promise.allSettled([off.server.close(), on.server.close()]);
}
