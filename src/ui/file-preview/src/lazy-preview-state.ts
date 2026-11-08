/**
 * Small, serializable state for closed File Preview cards.
 * Never persist file contents in a closed widget.
 */
import type { RenderPayload } from './model.js';
import { parseReadRange } from './document-workspace.js';

export const PREVIEW_MAX_LINES = 200;
export const PREVIEW_MAX_TEXT_BYTES = 64 * 1024;

export interface LazyPreviewState {
    kind: 'desktop-commander-lazy-preview';
    version: 1;
    readArgs: Record<string, unknown>;
    sourceTool?: 'read_file' | 'write_file' | 'edit_block';
}

export function isLazyPreviewState(value: unknown): value is LazyPreviewState {
    if (!value || typeof value !== 'object') return false;
    const state = value as Partial<LazyPreviewState>;
    return state.kind === 'desktop-commander-lazy-preview'
        && state.version === 1
        && !!state.readArgs
        && typeof state.readArgs.path === 'string'
        && state.readArgs.path.length > 0;
}

export function createLazyPreviewState(
    args: Record<string, unknown>,
    sourceTool?: LazyPreviewState['sourceTool'],
): LazyPreviewState {
    const { path, offset, length, sheet, range, isUrl } = args;
    if (typeof path !== 'string' || !path) {
        throw new Error('Preview requires a nonempty path');
    }
    const readArgs: Record<string, unknown> = { path };
    if (typeof offset === 'number' && Number.isInteger(offset)) readArgs.offset = offset;
    if (typeof length === 'number' && Number.isInteger(length) && length > 0) readArgs.length = length;
    if (typeof sheet === 'string') readArgs.sheet = sheet;
    if (typeof range === 'string') readArgs.range = range;
    if (typeof isUrl === 'boolean') readArgs.isUrl = isUrl;
    return { kind: 'desktop-commander-lazy-preview', version: 1, readArgs, sourceTool };
}

export function createLazyStateFromLegacy(payload: RenderPayload): LazyPreviewState {
    const range = parseReadRange(payload.content);
    const readArgs: Record<string, unknown> = { path: payload.filePath };
    if (range?.isPartial) {
        readArgs.offset = range.readOffset;
        readArgs.length = range.toLine - range.fromLine + 1;
    }
    return createLazyPreviewState(readArgs);
}

/** Limit UI-only requests without changing the model's original read. */
export function boundedPreviewReadArgs(state: LazyPreviewState): Record<string, unknown> {
    const args: Record<string, unknown> = {
        ...state.readArgs,
        origin: 'ui',
        options: { maxBytes: PREVIEW_MAX_TEXT_BYTES },
    };
    if (args.isUrl === true) return args; // URL reads ignore offsets and lengths; byte cap still applies to text responses.
    if (typeof args.offset === 'number' && args.offset < 0) {
        args.offset = Math.max(args.offset, -PREVIEW_MAX_LINES);
        delete args.length;
    } else {
        args.length = typeof args.length === 'number'
            ? Math.min(PREVIEW_MAX_LINES, Math.max(1, args.length))
            : PREVIEW_MAX_LINES;
    }
    return args;
}

/** Text-only display bound; Markdown uses previewTruncated metadata so editing can reload the complete document. */
export function boundPreviewRenderPayload(payload: RenderPayload): RenderPayload {
    if (payload.fileType === 'markdown' || payload.fileType === 'image') return payload;
    const bytes = new TextEncoder().encode(payload.content);
    if (bytes.length <= PREVIEW_MAX_TEXT_BYTES && payload.previewTruncated !== true) return payload;
    const visible = bytes.length > PREVIEW_MAX_TEXT_BYTES
        ? new TextDecoder().decode(bytes.subarray(0, PREVIEW_MAX_TEXT_BYTES))
        : payload.content;
    return {
        ...payload,
        content: visible + '\n\n[Preview truncated at 64 KiB. Use read_file to retrieve more.]',
    };
}
