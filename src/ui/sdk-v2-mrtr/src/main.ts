import { createToolBridge } from '../../shared/tool-bridge.js';

type Decision = 'accept' | 'decline';
type Choice = { id?: string; label?: string };
type OpenAiBridge = { toolOutput?: { structuredContent?: Record<string, unknown> } };

function openai(): OpenAiBridge | undefined {
    return (window as any).openai as OpenAiBridge | undefined;
}

interface ToolResultLike {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
}

const lifecycle = new AbortController();
let disposed = false;
const bridge = createToolBridge({ idPrefix: 'sdk-v2-mrtr' });

function dispose(): void {
    if (disposed) return;
    disposed = true;
    lifecycle.abort();
    bridge.dispose();
}

function handleHostMessage(event: MessageEvent): void {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.method !== 'ui/resource-teardown') return;
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
    window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    dispose();
}

function getButton(id: string): HTMLButtonElement {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${id}`);
    return element;
}

function getStatus(): HTMLElement {
    const element = document.getElementById('mrtr-status');
    if (!element) throw new Error('Missing MRTR status element');
    return element;
}

function resultText(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const result = value as ToolResultLike;
    const firstText = result.content?.find(item => item?.type === 'text' && typeof item.text === 'string')?.text;
    if (firstText) return firstText;
    const status = result.structuredContent?.status;
    return typeof status === 'string' ? status : undefined;
}

const acceptButton = getButton('mrtr-accept');
const declineButton = getButton('mrtr-decline');
const statusElement = getStatus();
const titleElement = document.getElementById('mrtr-title');
const copyElement = document.getElementById('mrtr-copy');

const structured = openai()?.toolOutput?.structuredContent;
const proposalId = typeof structured?.proposalId === 'string' ? structured.proposalId : 'sdk-v2-mrtr-demo';
if (titleElement && typeof structured?.prompt === 'string') titleElement.textContent = structured.prompt;
if (copyElement && typeof structured?.detail === 'string') copyElement.textContent = structured.detail;
if (Array.isArray(structured?.choices)) {
    const choices = structured.choices as Choice[];
    const accept = choices.find(choice => choice?.id === 'accept');
    const decline = choices.find(choice => choice?.id === 'decline');
    if (typeof accept?.label === 'string') acceptButton.textContent = accept.label;
    if (typeof decline?.label === 'string') declineButton.textContent = decline.label;
}

function setBusy(busy: boolean): void {
    if (disposed) return;
    acceptButton.disabled = busy;
    declineButton.disabled = busy;
}

async function decide(action: Decision): Promise<void> {
    if (disposed) return;
    setBusy(true);
    statusElement.textContent = action === 'accept' ? '承認を送信しています…' : '取消を送信しています…';
    try {
        const result = await bridge.callTool('sdk_v2_multi_round_trip_demo_app_decide', {
            origin: 'ui',
            action,
            proposalId,
        });
        if (disposed) return;
        statusElement.textContent = resultText(result)
            ?? (action === 'accept' ? '承認しました。変更は行われていません。' : '取消しました。変更は行われていません。');
        acceptButton.hidden = true;
        declineButton.hidden = true;
    } catch (error) {
        if (disposed) return;
        statusElement.textContent = `送信に失敗しました: ${error instanceof Error ? error.message : String(error)}`;
        setBusy(false);
    }
}

acceptButton.addEventListener('click', () => { void decide('accept'); }, { signal: lifecycle.signal });
declineButton.addEventListener('click', () => { void decide('decline'); }, { signal: lifecycle.signal });
window.addEventListener('message', handleHostMessage, { signal: lifecycle.signal });
window.addEventListener('beforeunload', dispose, { once: true, signal: lifecycle.signal });
