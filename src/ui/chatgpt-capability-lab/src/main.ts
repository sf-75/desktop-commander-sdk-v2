import { App } from '@modelcontextprotocol/ext-apps';
import { createToolBridge } from '../../shared/tool-bridge.js';
import { captureAppAutoResizeCleanup, closeAppAfterResourceTeardown } from '../../shared/host-context.js';

const RESOURCE_URI = 'ui://desktop-commander/chatgpt-capability-lab-v9';
const ECHO_TOOL = 'sdk_v2_chatgpt_capability_lab_echo';
const REPORT_TOOL = 'sdk_v2_chatgpt_capability_lab_report_v6';
const FILE_PARAM_PROBE_TOOL = 'sdk_v2_chatgpt_file_param_probe';
const DOCS_URL = 'https://developers.openai.com/plugins/reference';

type SelectedFile = { fileId: string; fileName?: string; mimeType?: string };
type LabState = {
  counter: number;
  lastAction: string;
  selectedFiles: SelectedFile[];
  uploadedFileId?: string;
  uploadedFileName?: string;
  uploadedMimeType?: string;
  downloadUrl?: string;
  downloadUrlFileId?: string;
  lastResourceUri?: string;
};

type OpenAiBridge = Record<string, any> & {
  widgetState?: any;
  setWidgetState?: (state: any) => void;
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  sendFollowUpMessage?: (args: { prompt: string; scrollToBottom?: boolean }) => Promise<unknown> | unknown;
  uploadFile?: (file: File, options?: { library?: boolean }) => Promise<{ fileId: string }>;
  selectFiles?: () => Promise<SelectedFile[]>;
  getFileDownloadUrl?: (args: { fileId: string }) => Promise<{ downloadUrl: string }>;
  requestDisplayMode?: (args: { mode: 'inline' | 'fullscreen' | 'pip' }) => Promise<unknown>;
  requestModal?: (args: { title?: string; params?: Record<string, unknown>; template?: string }) => Promise<unknown>;
  requestClose?: () => Promise<unknown> | unknown;
  notifyIntrinsicHeight?: (args?: { height?: number }) => Promise<unknown> | unknown;
  openExternal?: (args: { href: string; redirectUrl?: boolean }) => Promise<unknown> | unknown;
  setOpenInAppUrl?: (args: { href: string }) => Promise<unknown> | unknown;
  requestCheckout?: (...args: any[]) => Promise<unknown>;
};

const lifecycle = new AbortController();
let disposed = false;
let pendingHeightFrame: number | undefined;

const bridge = createToolBridge({ idPrefix: 'chatgpt-capability-lab' });
const disposeLab = (): void => {
  if (disposed) return;
  disposed = true;
  lifecycle.abort();
  cleanupAppAutoResize?.();
  if (pendingHeightFrame !== undefined) { window.cancelAnimationFrame(pendingHeightFrame); pendingHeightFrame = undefined; }
  // Drop selected-file metadata and short-lived download credentials even if a host API promise never settles.
  state = { counter: 0, lastAction: 'disposed', selectedFiles: [] };
  uploadInput.value = '';
  renderFiles();
  bridge.dispose();
};
window.addEventListener('beforeunload', disposeLab, { once: true, signal: lifecycle.signal });
const app = new App({ name: 'Desktop Commander ChatGPT Capability Lab', version: '1.0.0' }, {}, { autoResize: true });
const cleanupAppAutoResize = captureAppAutoResizeCleanup(app);

function openai(): OpenAiBridge | undefined {
  return (window as any).openai as OpenAiBridge | undefined;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}

const status = element<HTMLElement>('lab-status');
const stateValue = element<HTMLElement>('state-value');
const fileStatus = element<HTMLElement>('file-status');
const fileProbeStatus = element<HTMLElement>('file-probe-status');
const capabilityGrid = element<HTMLElement>('capability-grid');
const standardCapabilities = element<HTMLElement>('standard-capabilities');
const navStatus = element<HTMLElement>('nav-status');
const environment = element<HTMLElement>('environment');
const uploadInput = element<HTMLInputElement>('upload-input');
const uploadLibrary = element<HTMLInputElement>('upload-library');

function initialState(): LabState {
  const hostState = openai()?.widgetState;
  const candidate = hostState?.privateContent?.labState ?? hostState?.payload;
  if (candidate && typeof candidate === 'object') {
    return {
      counter: Number.isFinite(candidate.counter) ? Number(candidate.counter) : 0,
      lastAction: typeof candidate.lastAction === 'string' ? candidate.lastAction : 'restored',
      selectedFiles: Array.isArray(candidate.selectedFiles) ? candidate.selectedFiles : [],
      uploadedFileId: typeof candidate.uploadedFileId === 'string' ? candidate.uploadedFileId : undefined,
      uploadedFileName: typeof candidate.uploadedFileName === 'string' ? candidate.uploadedFileName : undefined,
      uploadedMimeType: typeof candidate.uploadedMimeType === 'string' ? candidate.uploadedMimeType : undefined,
      lastResourceUri: typeof candidate.lastResourceUri === 'string' ? candidate.lastResourceUri : undefined,
    };
  }
  return { counter: 0, lastAction: 'ready', selectedFiles: [] };
}

let state = initialState();

function imageIds(): string[] {
  const ids = state.selectedFiles
    .filter(file => file.mimeType?.startsWith('image/'))
    .map(file => file.fileId)
    .filter(Boolean);
  if (state.uploadedFileId && state.uploadedMimeType?.startsWith('image/')) ids.push(state.uploadedFileId);
  return [...new Set(ids)];
}

function persistState(): void {
  if (disposed) return;
  const host = openai();
  if (typeof host?.setWidgetState !== 'function') return;
  const persistedState = { ...state };
  // Presigned download URLs are short-lived credentials; keep them in memory only.
  delete persistedState.downloadUrl;
  delete persistedState.downloadUrlFileId;
  host.setWidgetState({
    modelContent: `ChatGPT UI capability lab: counter=${state.counter}; lastAction=${state.lastAction}.`,
    privateContent: { labState: persistedState },
    imageIds: imageIds(),
  });
}

function setStatus(message: string): void {
  if (disposed) return;
  state.lastAction = message;
  status.textContent = message;
  stateValue.textContent = `counter: ${state.counter} · last: ${state.lastAction}`;
  persistState();
  notifyHeight();
}

function renderFiles(): void {
  const selected = state.selectedFiles.map(file => `${file.fileName ?? file.fileId} (${file.mimeType ?? 'unknown'})`).join(', ');
  const parts = [selected ? `selected: ${selected}` : 'selected: none'];
  if (state.uploadedFileId) parts.push(`uploaded: ${state.uploadedFileId}`);
  if (state.downloadUrl && state.downloadUrlFileId) parts.push('download URL: acquired');
  fileStatus.textContent = parts.join(' · ');
}

function currentFileForProbe(): SelectedFile | undefined {
  if (state.uploadedFileId) {
    return { fileId: state.uploadedFileId, fileName: state.uploadedFileName, mimeType: state.uploadedMimeType };
  }
  return state.selectedFiles[0];
}

async function ensureDownloadUrl(fileId: string): Promise<string> {
  if (disposed) throw new Error('Capability Lab disposed');
  if (state.downloadUrl && state.downloadUrlFileId === fileId) return state.downloadUrl;
  const getUrl = requireHostMethod('getFileDownloadUrl');
  const result = await getUrl({ fileId });
  if (disposed) throw new Error('Capability Lab disposed');
  if (!result?.downloadUrl) throw new Error('downloadUrl missing');
  state.downloadUrl = result.downloadUrl;
  state.downloadUrlFileId = fileId;
  renderFiles();
  return result.downloadUrl;
}

const capabilityNames = [
  'setWidgetState', 'callTool', 'sendFollowUpMessage', 'uploadFile', 'selectFiles', 'getFileDownloadUrl',
  'requestDisplayMode', 'requestModal', 'requestClose', 'notifyIntrinsicHeight', 'openExternal', 'setOpenInAppUrl',
  'requestCheckout',
];


function buildCapabilityReport(): Record<string, unknown> {
  const host = openai();
  const hostCapabilities = app.getHostCapabilities();
  const hostVersion = app.getHostVersion();
  const hostContext = app.getHostContext();
  const rectHeight = (selector: string): number => {
    const value = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().height ?? 0;
    return Math.round(value);
  };
  const bodyStyle = getComputedStyle(document.body);
  const card = document.querySelector<HTMLElement>('.lab-card');
  const cardStyle = card ? getComputedStyle(card) : null;
  const basicPanel = element<HTMLElement>('panel-basic');
  const basicPanelStyle = getComputedStyle(basicPanel);
  const basicPanelFirstChild = basicPanel.firstElementChild as HTMLElement | null;
  const basicPanelFirstChildStyle = basicPanelFirstChild ? getComputedStyle(basicPanelFirstChild) : null;
  const scrollRegion = document.getElementById('panel-scroll') as HTMLElement | null;
  const scrollRegionStyle = scrollRegion ? getComputedStyle(scrollRegion) : null;
  const layoutDiagnostics = {
    bodyClassName: document.body.className.slice(0, 100),
    bodyMaxHeight: bodyStyle.maxHeight,
    bodyHeight: Math.round(Number.parseFloat(bodyStyle.height) || 0),
    bodyScrollHeight: document.body.scrollHeight,
    bodyBackgroundColor: bodyStyle.backgroundColor,
    bodyColor: bodyStyle.color,
    bodyVisibility: bodyStyle.visibility,
    bodyOpacity: bodyStyle.opacity,
    documentElementClientHeight: document.documentElement.clientHeight,
    documentElementScrollHeight: document.documentElement.scrollHeight,
    windowInnerHeight: window.innerHeight,
    cardHeight: rectHeight('.lab-card'),
    cardDisplay: cardStyle?.display ?? '',
    cardVisibility: cardStyle?.visibility ?? '',
    cardOpacity: cardStyle?.opacity ?? '',
    cardBackgroundColor: cardStyle?.backgroundColor ?? '',
    cardColor: cardStyle?.color ?? '',
    headerHeight: rectHeight('.lab-header'),
    tabsHeight: rectHeight('.lab-tabs'),
    basicPanelHeight: rectHeight('#panel-basic'),
    basicPanelDisplay: basicPanelStyle.display,
    basicPanelVisibility: basicPanelStyle.visibility,
    basicPanelOpacity: basicPanelStyle.opacity,
    basicPanelBackgroundColor: basicPanelStyle.backgroundColor,
    basicPanelColor: basicPanelStyle.color,
    basicPanelTextLength: (basicPanel.textContent ?? '').trim().length,
    basicPanelChildCount: basicPanel.childElementCount,
    basicPanelFirstChildTag: basicPanelFirstChild?.tagName ?? '',
    basicPanelFirstChildHeight: Math.round(basicPanelFirstChild?.getBoundingClientRect().height ?? 0),
    basicPanelFirstChildDisplay: basicPanelFirstChildStyle?.display ?? '',
    basicPanelHidden: basicPanel.hidden,
    scrollRegionClientHeight: scrollRegion?.clientHeight ?? 0,
    scrollRegionScrollHeight: scrollRegion?.scrollHeight ?? 0,
    scrollRegionOverflowY: scrollRegionStyle?.overflowY ?? '',
    readyState: document.readyState,
  };
  return {
    origin: 'ui',
    labBuildVersion: 9,
    labResourceUri: RESOURCE_URI,
    layoutDiagnostics,
    windowMethods: capabilityNames.filter(name => typeof host?.[name] === 'function'),
    hostCapabilityKeys: hostCapabilities && typeof hostCapabilities === 'object' ? Object.keys(hostCapabilities).sort() : [],
    ...(hostVersion?.name ? { hostName: hostVersion.name } : {}),
    ...(hostVersion?.version ? { hostVersion: hostVersion.version } : {}),
    ...(hostContext?.displayMode ? { displayMode: hostContext.displayMode } : {}),
    availableDisplayModes: Array.isArray(hostContext?.availableDisplayModes) ? [...hostContext.availableDisplayModes] : [],
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message) return message;
    try { return JSON.stringify(error); } catch { /* fall through */ }
  }
  return String(error);
}

async function callLabServerTool(name: string, args: Record<string, unknown>): Promise<any> {
  if (disposed) throw new Error('Capability Lab disposed');
  const result = await app.callServerTool({ name, arguments: args }, { signal: lifecycle.signal, });
  if (disposed) throw new Error('Capability Lab disposed');
  if (result.isError) {
    const message = Array.isArray(result.content)
      ? result.content.map((block: any) => block?.type === 'text' ? block.text : '').filter(Boolean).join('; ')
      : '';
    throw new Error(message || `${name} returned isError`);
  }
  return result;
}

async function sendAutoCapabilityReport(): Promise<void> {
  const report = buildCapabilityReport();
  // The host may retain the v6 tool catalog after refreshing the MCP connection.
  // Keep this call within that cached input schema; the v9 boot echo identifies the loaded UI build.
  delete report.labBuildVersion;
  delete report.labResourceUri;
  await callLabServerTool(REPORT_TOOL, report);
}

function renderCapabilities(): void {
  const host = openai();
  capabilityGrid.replaceChildren();
  for (const name of capabilityNames) {
    const item = document.createElement('div');
    const supported = typeof host?.[name] === 'function';
    item.className = `capability ${supported ? 'capability-ok' : 'capability-missing'}`;
    item.textContent = `${supported ? '✓' : '–'} ${name}`;
    capabilityGrid.appendChild(item);
  }
}

function renderStandardCapabilities(): void {
  const caps = app.getHostCapabilities();
  const context = app.getHostContext();
  standardCapabilities.textContent = JSON.stringify({
    hostVersion: app.getHostVersion() ?? null,
    capabilities: caps ?? null,
    hostContext: context ?? null,
  }, null, 2);
  const samplingButton = element<HTMLButtonElement>('std-sampling');
  samplingButton.disabled = !caps?.sampling;
  samplingButton.title = caps?.sampling ? 'Host advertises sampling' : 'Host does not advertise sampling';
}

function renderEnvironment(): void {
  const host = openai();
  const metadata = host?.toolResponseMetadata;
  const snapshot = {
    theme: host?.theme ?? null,
    displayMode: host?.displayMode ?? null,
    maxHeight: host?.maxHeight ?? null,
    safeArea: host?.safeArea ?? null,
    view: host?.view ?? null,
    userAgent: host?.userAgent ?? null,
    locale: host?.locale ?? null,
    toolInputPresent: host?.toolInput != null,
    toolOutputPresent: host?.toolOutput != null,
    toolResponseMetadataPresent: metadata != null,
    toolResponseMetadataKeys: metadata && typeof metadata === 'object' ? Object.keys(metadata) : [],
  };
  environment.textContent = JSON.stringify(snapshot, null, 2);
}

function renderNavigation(): void {
  navStatus.textContent = `${location.pathname}${location.search}${location.hash}`;
}

function notifyHeight(): void {
  if (disposed) return;
  const host = openai();
  if (typeof host?.notifyIntrinsicHeight !== 'function') return;
  if (pendingHeightFrame !== undefined) window.cancelAnimationFrame(pendingHeightFrame);
  pendingHeightFrame = window.requestAnimationFrame(() => {
    pendingHeightFrame = undefined;
    if (disposed) return;
    try {
      // The app card is viewport-bounded; report the viewport height to avoid a resize feedback loop.
      const height = Math.ceil(document.documentElement.clientHeight || document.documentElement.scrollHeight);
      host.notifyIntrinsicHeight?.({ height });
    } catch {
      // Optional extension; ignore host-specific failures.
    }
  });
}

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'));
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>('[data-panel]'));

function activateTab(name: string, focus = false): void {
  const activeTab = tabButtons.find(tab => tab.dataset.tab === name);
  if (!activeTab) return;

  for (const tab of tabButtons) {
    const active = tab === activeTab;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of tabPanels) panel.hidden = panel.dataset.panel !== name;

  const scrollRegion = document.getElementById('panel-scroll');
  if (scrollRegion) scrollRegion.scrollTop = 0;
  if (focus) activeTab.focus();
  notifyHeight();
}

for (const [index, tab] of tabButtons.entries()) {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab ?? 'basic'), { signal: lifecycle.signal });
  tab.addEventListener('keydown', event => {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction || tabButtons.length < 2) return;
    event.preventDefault();
    const next = tabButtons[(index + direction + tabButtons.length) % tabButtons.length];
    activateTab(next.dataset.tab ?? 'basic', true);
  }, { signal: lifecycle.signal });
}

async function run(label: string, fn: () => Promise<void> | void): Promise<void> {
  if (disposed) return;
  status.textContent = `${label}: running?`;
  try {
    await fn();
    if (disposed) return;
    setStatus(`${label}: ok`);
  } catch (error) {
    if (disposed) return;
    setStatus(`${label}: ${describeError(error)}`);
  }
}

function requireHostMethod(name: string): (...args: any[]) => any {
  if (disposed) throw new Error('Capability Lab disposed');
  const method = openai()?.[name];
  if (typeof method !== 'function') throw new Error(`${name} unsupported`);
  return method.bind(openai());
}

async function verifyEcho(result: any, expected: string): Promise<void> {
  if (result?.structuredContent?.echo !== expected) throw new Error('unexpected echo result');
}

element<HTMLButtonElement>('state-inc').addEventListener('click', () => {
  state.counter += 1;
  setStatus('widgetState persisted');
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('context-update').addEventListener('click', () => {
  void run('updateModelContext', async () => {
    await app.updateModelContext({
      content: [{ type: 'text', text: `Capability lab state: counter=${state.counter}.` }],
      structuredContent: { source: 'chatgpt-capability-lab', counter: state.counter, lastAction: state.lastAction },
    }, { signal: lifecycle.signal, });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('follow-up').addEventListener('click', () => {
  void run('sendFollowUpMessage', async () => {
    const send = requireHostMethod('sendFollowUpMessage');
    await send({ prompt: 'このCapability Labで最後に確認した機能と結果を短く要約して。', scrollToBottom: true });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('call-tool').addEventListener('click', () => {
  void run('window.openai.callTool', async () => {
    const result = await bridge.callTool(ECHO_TOOL, { origin: 'ui', message: `counter=${state.counter}` });
    await verifyEcho(result, `counter=${state.counter}`);
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-call-tool').addEventListener('click', () => {
  void run('app.callServerTool', async () => {
    const expected = `standard-counter=${state.counter}`;
    const result = await app.callServerTool({ name: ECHO_TOOL, arguments: { origin: 'ui', message: expected } }, { signal: lifecycle.signal, });
    await verifyEcho(result, expected);
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-tool-list-changed').addEventListener('click', () => {
  void run('app.sendToolListChanged', async () => {
    await app.sendToolListChanged();
  });
}, { signal: lifecycle.signal });
element<HTMLButtonElement>('std-list-resources').addEventListener('click', () => {
  void run('app.listServerResources', async () => {
    const result = await app.listServerResources(undefined, { signal: lifecycle.signal, });
    if (disposed) return;
    state.lastResourceUri = result.resources.find(resource => resource.uri === RESOURCE_URI)?.uri ?? result.resources[0]?.uri;
    if (!state.lastResourceUri) throw new Error('no resources returned');
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-read-resource').addEventListener('click', () => {
  void run('app.readServerResource', async () => {
    const uri = state.lastResourceUri ?? RESOURCE_URI;
    const result = await app.readServerResource({ uri }, { signal: lifecycle.signal, });
    if (!result.contents?.length) throw new Error('empty resource result');
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-message').addEventListener('click', () => {
  void run('app.sendMessage', async () => {
    const result = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: `Capability Lab standard ui/message test, counter=${state.counter}.` }],
    }, { signal: lifecycle.signal, });
    if (result.isError) throw new Error('host rejected message');
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-log').addEventListener('click', () => {
  void run('app.sendLog', async () => {
    await app.sendLog({ level: 'info', logger: 'desktop-commander-capability-lab', data: { event: 'manual-test', counter: state.counter } });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-open-link').addEventListener('click', () => {
  void run('app.openLink', async () => {
    const result = await app.openLink({ url: DOCS_URL }, { signal: lifecycle.signal, });
    if (result.isError) throw new Error('host rejected link');
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-download').addEventListener('click', () => {
  void run('app.downloadFile', async () => {
    const result = await app.downloadFile({
      contents: [{
        type: 'resource',
        resource: {
          uri: 'file:///desktop-commander-capability-lab.txt',
          mimeType: 'text/plain',
          text: `Desktop Commander Capability Lab\ncounter=${state.counter}\n`,
        },
      }],
    }, { signal: lifecycle.signal, });
    if (result.isError) throw new Error('host rejected download');
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-display').addEventListener('click', () => {
  void run('app.requestDisplayMode', async () => {
    const context = app.getHostContext();
    const available = context?.availableDisplayModes ?? [];
    const requested = context?.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
    if (!available.includes(requested)) throw new Error(`${requested} unavailable`);
    await app.requestDisplayMode({ mode: requested }, { signal: lifecycle.signal, });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-size').addEventListener('click', () => {
  void run('app.sendSizeChanged', async () => {
    await app.sendSizeChanged({ height: document.documentElement.scrollHeight });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-sampling').addEventListener('click', () => {
  void run('app.createSamplingMessage', async () => {
    if (!app.getHostCapabilities()?.sampling) throw new Error('sampling unsupported');
    const result = await app.createSamplingMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Reply with exactly: capability-lab-sampling-ok' } }],
      maxTokens: 32,
    }, { signal: lifecycle.signal, });
    if (!result.content) throw new Error('empty sampling result');
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('std-teardown').addEventListener('click', () => {
  void run('app.requestTeardown', async () => {
    await app.requestTeardown();
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('select-files').addEventListener('click', () => {
  void run('selectFiles', async () => {
    const selectFiles = requireHostMethod('selectFiles');
    const files = await selectFiles();
    if (disposed) return;
    state.selectedFiles = Array.isArray(files) ? files : [];
    renderFiles();
  });
}, { signal: lifecycle.signal });

uploadInput.addEventListener('change', () => {
  void run('uploadFile', async () => {
    const file = uploadInput.files?.[0];
    if (!file) throw new Error('file not selected');
    const upload = requireHostMethod('uploadFile');
    const result = await upload(file, { library: uploadLibrary.checked });
    if (disposed) return;
    if (!result?.fileId) throw new Error('fileId missing');
    state.uploadedFileId = result.fileId;
    state.uploadedFileName = file.name || undefined;
    state.uploadedMimeType = file.type || undefined;
    state.downloadUrl = undefined;
    state.downloadUrlFileId = undefined;
    fileProbeStatus.textContent = 'file param probe: not run';
    renderFiles();
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('download-url').addEventListener('click', () => {
  void run('getFileDownloadUrl', async () => {
    const file = currentFileForProbe();
    if (!file?.fileId) throw new Error('no fileId available');
    await ensureDownloadUrl(file.fileId);
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('probe-file-param').addEventListener('click', () => {
  void run('file param probe', async () => {
    const file = currentFileForProbe();
    if (!file?.fileId) throw new Error('select or upload a file first');
    fileProbeStatus.textContent = 'file param probe: running…';
    const downloadUrl = await ensureDownloadUrl(file.fileId);
    const fileParam: Record<string, unknown> = {
      download_url: downloadUrl,
      file_id: file.fileId,
    };
    if (file.mimeType) fileParam.mime_type = file.mimeType;
    if (file.fileName) fileParam.file_name = file.fileName;
    const result = await callLabServerTool(FILE_PARAM_PROBE_TOOL, { file: fileParam });
    if (disposed) return;
    const report = result?.structuredContent;
    if (report?.fileId !== file.fileId || report?.hasDownloadUrl !== true) {
      throw new Error('file param probe response did not match the selected file');
    }
    fileProbeStatus.textContent = `file param probe: received ${report.fileName ?? report.fileId} (${report.mimeType ?? 'unknown'}); download URL supplied`;
  });
}, { signal: lifecycle.signal });

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', () => {
    void run(`window display:${button.dataset.mode}`, async () => {
      const requestDisplayMode = requireHostMethod('requestDisplayMode');
      await requestDisplayMode({ mode: button.dataset.mode });
    });
  }, { signal: lifecycle.signal });
}

element<HTMLButtonElement>('modal').addEventListener('click', () => {
  void run('requestModal', async () => {
    const requestModal = requireHostMethod('requestModal');
    await requestModal({ title: 'Capability Lab', template: RESOURCE_URI, params: { source: 'capability-lab', counter: state.counter } });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('height').addEventListener('click', () => {
  void run('notifyIntrinsicHeight', () => {
    const notify = requireHostMethod('notifyIntrinsicHeight');
    notify({ height: document.documentElement.scrollHeight });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('close').addEventListener('click', () => {
  void run('requestClose', async () => {
    const close = requireHostMethod('requestClose');
    await close();
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('open-docs').addEventListener('click', () => {
  void run('openExternal', async () => {
    const open = requireHostMethod('openExternal');
    await open({ href: DOCS_URL, redirectUrl: false });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('set-open-url').addEventListener('click', () => {
  void run('setOpenInAppUrl', async () => {
    const setUrl = requireHostMethod('setOpenInAppUrl');
    await setUrl({ href: DOCS_URL });
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('nav-detail').addEventListener('click', () => {
  void run('history.pushState', () => {
    history.pushState({ capabilityLab: true }, '', './detail?source=capability-lab');
    renderNavigation();
  });
}, { signal: lifecycle.signal });

element<HTMLButtonElement>('nav-back').addEventListener('click', () => {
  history.back();
}, { signal: lifecycle.signal });

window.addEventListener('popstate', renderNavigation, { signal: lifecycle.signal });
window.addEventListener('openai:set_globals', () => {
  renderCapabilities();
  renderEnvironment();
  notifyHeight();
}, { signal: lifecycle.signal });

app.onhostcontextchanged = () => {
  if (disposed) return;
  renderStandardCapabilities();
  renderEnvironment();
  notifyHeight();
};

app.onteardown = async () => {
  try {
    persistState();
  } finally {
    disposeLab();
    if (cleanupAppAutoResize) closeAppAfterResourceTeardown(app, cleanupAppAutoResize);
    app.onhostcontextchanged = undefined;
    app.onteardown = undefined;
  }
  return {};
};

activateTab('basic');
renderCapabilities();
renderEnvironment();
renderNavigation();
renderFiles();
stateValue.textContent = `counter: ${state.counter} · last: ${state.lastAction}`;
document.body.classList.add('dc-ready');
persistState();
notifyHeight();

void app.connect().then(async () => {
  if (disposed) return;
  renderStandardCapabilities();
  renderEnvironment();
  let bootEchoStatus = 'boot echo not attempted';
  try {
    const expected = 'capability-lab-v9-runtime-boot';
    await verifyEcho(await callLabServerTool(ECHO_TOOL, { origin: 'ui', message: expected }), expected);
    if (disposed) return;
    bootEchoStatus = 'boot echo ok';
  } catch (error) {
    if (disposed) return;
    bootEchoStatus = `boot echo failed: ${describeError(error)}`;
  }
  try {
    await sendAutoCapabilityReport();
    if (disposed) return;
    setStatus(`host connected · ${bootEchoStatus} · auto report sent`);
  } catch (error) {
    if (disposed) return;
    setStatus(`host connected · ${bootEchoStatus} · auto report failed: ${describeError(error)}`);
  }
}).catch((error) => {
  if (disposed) return;
  standardCapabilities.textContent = 'host not connected';
  setStatus(`host connect: ${describeError(error)}`);
});
