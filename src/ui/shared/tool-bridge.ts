type ToolArgs = Record<string, unknown>;

type ToolHelper = {
    callTool: (name: string, args: ToolArgs) => Promise<unknown> | unknown;
};

type MessageEventLike = {
    data: unknown;
    origin?: string;
    source?: unknown;
};

type MessageListener = (event: MessageEventLike) => void;

type MessageTarget = {
    postMessage: (message: unknown, targetOrigin?: string) => void;
};

type BridgeHost = {
    openai?: ToolHelper;
    mcp?: ToolHelper;
    parent?: MessageTarget;
    addEventListener?: (type: 'message', listener: MessageListener) => void;
    removeEventListener?: (type: 'message', listener: MessageListener) => void;
};

export interface ToolBridgeOptions {
    host?: BridgeHost;
    requestTimeoutMs?: number;
    targetOrigin?: string;
    idPrefix?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

interface PendingFallbackRequest {
    timeoutHandle: ReturnType<typeof setTimeout>;
    removeListener: () => void;
    reject: (error: Error) => void;
}

function getDefaultTargetOrigin(): string {
    if (typeof document === 'undefined') {
        return '*';
    }

    const referrer = document.referrer;
    if (typeof referrer !== 'string' || referrer.trim().length === 0) {
        return '*';
    }

    try {
        return new URL(referrer).origin;
    } catch {
        return '*';
    }
}

function normalizeTargetOrigin(value: string): string {
    if (value === '*') {
        return value;
    }

    try {
        return new URL(value).origin;
    } catch {
        throw new Error(`Invalid targetOrigin: ${value}`);
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeToolArgs(args: ToolArgs | undefined): ToolArgs {
    return args ?? {};
}

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

function isHelperUnavailableError(error: unknown): boolean {
    if (!isObject(error)) {
        return false;
    }

    const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
    if (code === 'not_implemented' || code === 'not_supported' || code === 'unavailable') {
        return true;
    }

    const message = extractErrorMessage(error).toLowerCase();
    return message.includes('not implemented')
        || message.includes('not supported')
        || message.includes('unavailable')
        || message.includes('not available');
}

export function createToolBridge(options: ToolBridgeOptions = {}) {
    const host = options.host ?? (globalThis as BridgeHost);
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const targetOrigin = normalizeTargetOrigin(options.targetOrigin ?? getDefaultTargetOrigin());
    const idPrefix = options.idPrefix ?? 'tool-bridge';
    let requestCounter = 0;
    let disposed = false;
    const disposedError = new Error('Tool bridge has been disposed');
    const pendingFallbacks = new Map<string, PendingFallbackRequest>();
    let resolveDisposed!: () => void;
    const disposedSignal = new Promise<void>((resolve) => { resolveDisposed = resolve; });
    const disposedRace = disposedSignal.then(() => { throw disposedError; });
    void disposedRace.catch(() => undefined);

    async function callViaFallback(name: string, args: ToolArgs): Promise<unknown> {
        if (!host.parent || !host.addEventListener || !host.removeEventListener) {
            throw new Error('JSON-RPC fallback is unavailable in this host environment.');
        }

        const parent = host.parent;
        const addListener = (type: 'message', listener: MessageListener): void => {
            host.addEventListener?.(type, listener);
        };
        const removeListener = (type: 'message', listener: MessageListener): void => {
            host.removeEventListener?.(type, listener);
        };

        requestCounter += 1;
        const requestId = `${idPrefix}:${requestCounter}`;

        if (disposed) throw disposedError;
        return new Promise((resolve, reject) => {
            let timeoutHandle: ReturnType<typeof setTimeout>;
            const cleanup = (): void => {
                clearTimeout(timeoutHandle);
                removeListener('message', onMessage);
                pendingFallbacks.delete(requestId);
            };
            const onMessage: MessageListener = (event) => {
                const payload = event.data;
                if (event.source !== parent) {
                    return;
                }
                if (targetOrigin !== '*' && event.origin !== targetOrigin) {
                    return;
                }
                if (!isObject(payload) || payload.id !== requestId) {
                    return;
                }

                cleanup();
                if (isObject(payload.error)) {
                    const rawMessage = payload.error.message;
                    const message = typeof rawMessage === 'string'
                        ? rawMessage
                        : 'Unknown tools/call fallback error';
                    reject(new Error(`Tool call fallback failed: ${message}`));
                    return;
                }
                resolve(payload.result);
            };
            timeoutHandle = setTimeout(() => {
                cleanup();
                reject(new Error(`Tool call fallback timed out after ${timeoutMs}ms (request: ${requestId})`));
            }, timeoutMs);
            pendingFallbacks.set(requestId, {
                timeoutHandle,
                removeListener: () => removeListener('message', onMessage),
                reject,
            });
            try {
                addListener('message', onMessage);
                parent.postMessage(
                    {
                        jsonrpc: '2.0',
                        id: requestId,
                        method: 'tools/call',
                        params: {
                            name,
                            arguments: args,
                        },
                    },
                    targetOrigin
                );
            } catch (error) {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    async function callTool(name: string, args?: ToolArgs): Promise<unknown> {
        if (disposed) throw disposedError;
        const normalizedArgs = normalizeToolArgs(args);
        const helperCandidates = [host.openai, host.mcp].filter(
            (candidate): candidate is ToolHelper => Boolean(candidate?.callTool)
        );

        for (const helper of helperCandidates) {
            try {
                return await Promise.race([
                    helper.callTool(name, normalizedArgs),
                    disposedRace,
                ]);
            } catch (error) {
                if (disposed) throw disposedError;
                if (isHelperUnavailableError(error)) {
                    continue;
                }
                throw new Error(`Tool helper call failed: ${extractErrorMessage(error)}`);
            }
        }

        try {
            return await callViaFallback(name, normalizedArgs);
        } catch (fallbackError) {
            throw fallbackError;
        }
    }

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        resolveDisposed();
        for (const pending of pendingFallbacks.values()) {
            clearTimeout(pending.timeoutHandle);
            pending.removeListener();
            pending.reject(disposedError);
        }
        pendingFallbacks.clear();
    };

    return {
        callTool,
        dispose,
    };
}
