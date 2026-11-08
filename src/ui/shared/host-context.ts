import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiStyles } from '@modelcontextprotocol/ext-apps';

export interface UiChromeState {
    expanded: boolean;
    hideSummaryRow: boolean;
    compact?: boolean;
}

type AppWithAutoResizeCleanup = {
    setupSizeChangedNotifications?: () => (() => void) | void;
    sendSizeChanged?: (params: { width?: number; height?: number }) => Promise<void>;
};

export function captureAppAutoResizeCleanup(app: App): (() => void) | undefined {
    const appWithCleanup = app as unknown as AppWithAutoResizeCleanup;
    const originalSetup = appWithCleanup.setupSizeChangedNotifications;
    if (typeof originalSetup !== 'function') return undefined;

    let disconnect: (() => void) | undefined;
    let disposed = false;
    const originalSendSizeChanged = appWithCleanup.sendSizeChanged?.bind(app);
    if (originalSendSizeChanged) {
        appWithCleanup.sendSizeChanged = (params: { width?: number; height?: number }) => {
            if (disposed) return Promise.resolve();
            return originalSendSizeChanged(params);
        };
    }
    appWithCleanup.setupSizeChangedNotifications = function (this: AppWithAutoResizeCleanup) {
        disconnect?.();
        const cleanup = originalSetup.call(this);
        disconnect = typeof cleanup === 'function' ? cleanup : undefined;
        return cleanup;
    };

    return () => {
        disposed = true;
        const cleanup = disconnect;
        disconnect = undefined;
        cleanup?.();
    };
}

export function closeAppAfterResourceTeardown(app: App, cleanupAutoResize: () => void): void {
    // The host sends the JSON-RPC response after onteardown resolves. Close on the next task.
    window.setTimeout(() => {
        cleanupAutoResize();
        void app.close().catch(() => undefined);
    }, 0);
}
export interface ConnectWithSharedHostContextOptions {
    app: App;
    chrome: UiChromeState;
    alreadyConnected?: boolean;
    onContextApplied?: () => void;
    onConnected?: () => void | Promise<void>;
    signal?: AbortSignal;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function applySharedHostContext(context: unknown, chrome: UiChromeState): void {
    if (!isObjectRecord(context)) {
        return;
    }

    if (context.theme === 'light' || context.theme === 'dark') {
        applyDocumentTheme(context.theme);
    }

    const styles = isObjectRecord(context.styles) ? context.styles : null;
    const variables = isObjectRecord(styles?.variables) ? styles.variables : null;
    const css = isObjectRecord(styles?.css) ? styles.css : null;
    const fonts = typeof css?.fonts === 'string' ? css.fonts : null;

    if (variables) {
        applyHostStyleVariables(variables as unknown as McpUiStyles);
    }
    if (fonts) {
        applyHostFonts(fonts);
    }

    if (typeof context.initiallyExpanded === 'boolean') {
        chrome.expanded = context.initiallyExpanded;
    }

    if (typeof context.compact === 'boolean' && typeof chrome.compact === 'boolean') {
        chrome.compact = context.compact;
    }

    if (typeof context.hideSummaryRow === 'boolean') {
        chrome.hideSummaryRow = context.hideSummaryRow;
        if (context.hideSummaryRow) {
            chrome.expanded = true;
            if (typeof chrome.compact === 'boolean') {
                chrome.compact = true;
            }
        }
    }
}

export async function connectWithSharedHostContext(options: ConnectWithSharedHostContextOptions): Promise<void> {
    const { app, chrome, onContextApplied, onConnected, signal } = options;
    if (signal?.aborted) return;

    const handleHostContextChanged = (context: unknown): void => {
        if (signal?.aborted) return;
        applySharedHostContext(context, chrome);
        onContextApplied?.();
    };
    const clearHostContextHandler = (): void => {
        if (app.onhostcontextchanged === handleHostContextChanged) {
            app.onhostcontextchanged = undefined;
        }
    };

    app.onhostcontextchanged = handleHostContextChanged;
    signal?.addEventListener('abort', clearHostContextHandler, { once: true });

    try {
        if (!options.alreadyConnected) await app.connect();
        if (signal?.aborted) return;

        const hostContext = app.getHostContext();
        if (hostContext) handleHostContextChanged(hostContext);
        if (signal?.aborted) return;

        await onConnected?.();
    } catch (error) {
        clearHostContextHandler();
        signal?.removeEventListener('abort', clearHostContextHandler);
        throw error;
    }
}
