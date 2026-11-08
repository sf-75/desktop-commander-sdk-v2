/**
 * Server-side UI resource loading helpers for MCP responses. It resolves packaged UI assets, reads files safely, and exposes structured resource payloads to clients.
 */
import fs from 'fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    buildUiContentSecurityPolicy,
    CHATGPT_CAPABILITY_LAB_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V6_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V5_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V4_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V3_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V2_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_LEGACY_RESOURCE_URI,
    CONFIG_EDITOR_RESOURCE_URI,
    FILE_PREVIEW_RESOURCE_URI,
    SDK_V2_MRTR_RESOURCE_URI,
    UI_FONT_ORIGINS,
    UI_RESOURCE_CSP
} from './contracts.js';

const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export const FILE_PREVIEW_RESOURCE = {
    uri: FILE_PREVIEW_RESOURCE_URI,
    name: 'Desktop Commander File Preview',
    description: 'Markdown-first preview surface for read_file structured content.',
    mimeType: UI_RESOURCE_MIME_TYPE
};

export const CONFIG_EDITOR_RESOURCE = {
    uri: CONFIG_EDITOR_RESOURCE_URI,
    name: 'Desktop Commander Config Editor',
    description: 'Interactive editor for Desktop Commander configuration values.',
    mimeType: UI_RESOURCE_MIME_TYPE
};

export const SDK_V2_MRTR_RESOURCE = {
    uri: SDK_V2_MRTR_RESOURCE_URI,
    name: 'Desktop Commander SDK v2 Multi-Round-Trip Demo',
    description: 'Interactive approve/decline fallback UI for the SDK v2 multi-round-trip demo.',
    mimeType: UI_RESOURCE_MIME_TYPE
};

export const CHATGPT_CAPABILITY_LAB_RESOURCE = {
    uri: CHATGPT_CAPABILITY_LAB_RESOURCE_URI,
    name: 'Desktop Commander ChatGPT UI Capability Lab',
    description: 'Interactive self-test for ChatGPT conversation UI capabilities exposed to MCP Apps.',
    mimeType: UI_RESOURCE_MIME_TYPE
};

interface ReadableUiResource {
    mimeType: string;
    getText: () => Promise<string>;
    getMeta?: () => Record<string, unknown>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_FILE_PREVIEW_DIR = path.resolve(__dirname, 'file-preview');
const DIST_CONFIG_EDITOR_DIR = path.resolve(__dirname, 'config-editor');
const DIST_SDK_V2_MRTR_DIR = path.resolve(__dirname, 'sdk-v2-mrtr');
const DIST_CHATGPT_CAPABILITY_LAB_DIR = path.resolve(__dirname, 'chatgpt-capability-lab');

function replaceOrThrow(
    source: string,
    pattern: RegExp,
    replacement: string,
    context: string
): string {
    if (!pattern.test(source)) {
        throw new Error(`UI template is missing expected ${context}`);
    }
    return source.replace(pattern, () => replacement);
}

function inlineTemplateAssets(templateHtml: string, css: string, runtime: string): string {
    const safeCss = css.replace(/<\/style/gi, '<\\/style');
    const safeRuntime = runtime.replace(/<\/script/gi, '<\\/script');

    // First in <head>, so it covers everything the page loads, previews included
    const policyAdded = replaceOrThrow(
        templateHtml,
        /<head>/i,
        `<head><meta http-equiv="Content-Security-Policy" content="${buildUiContentSecurityPolicy(UI_RESOURCE_CSP, UI_FONT_ORIGINS)}">`,
        '<head> tag'
    );
    const cssInlined = replaceOrThrow(
        policyAdded,
        /<link[^>]*href=["']\.\/styles\.css["'][^>]*>/i,
        `<style>${safeCss}</style>`,
        'styles.css link tag'
    );
    const runtimeInlined = replaceOrThrow(
        cssInlined,
        /<script[^>]*src=["']\.\/[^"']+["'][^>]*>\s*<\/script>/i,
        `<script>${safeRuntime}</script>`,
        'runtime script tag'
    );
    if (
        /href=["']\.\/styles\.css["']/i.test(runtimeInlined) ||
        /<script[^>]*src=["']\.\/[^"']+["']/i.test(runtimeInlined)
    ) {
        throw new Error('UI template still contains external static asset references after inlining');
    }
    return runtimeInlined;
}

async function readInlinedResourceHtml(distDir: string, runtimeFileName: string): Promise<string> {
    const [templateHtml, css, runtime] = await Promise.all([
        fs.readFile(path.join(distDir, 'index.html'), 'utf8'),
        fs.readFile(path.join(distDir, 'styles.css'), 'utf8'),
        fs.readFile(path.join(distDir, runtimeFileName), 'utf8')
    ]);
    return inlineTemplateAssets(templateHtml, css, runtime);
}

export async function getFilePreviewResourceText(): Promise<string> {
    return readInlinedResourceHtml(DIST_FILE_PREVIEW_DIR, 'preview-runtime.js');
}

let cachedFullPreviewRuntime: Promise<string> | undefined;

/** Serve only our bundled viewer, gzip+base64, on an explicit UI request. */
export function getCompressedFilePreviewRuntime(): Promise<string> {
    if (!cachedFullPreviewRuntime) {
        cachedFullPreviewRuntime = fs.readFile(path.join(DIST_FILE_PREVIEW_DIR, 'preview-full-runtime.js'))
            .then(bytes => gzipSync(bytes, { level: 6 }).toString('base64'))
            .catch(error => {
                cachedFullPreviewRuntime = undefined;
                throw error;
            });
    }
    return cachedFullPreviewRuntime;
}

export async function getConfigEditorResourceText(): Promise<string> {
    return readInlinedResourceHtml(DIST_CONFIG_EDITOR_DIR, 'config-editor-runtime.js');
}

export async function getSdkV2MrtrResourceText(): Promise<string> {
    return readInlinedResourceHtml(DIST_SDK_V2_MRTR_DIR, 'sdk-v2-mrtr-runtime.js');
}

export async function getChatGptCapabilityLabResourceText(): Promise<string> {
    return readInlinedResourceHtml(DIST_CHATGPT_CAPABILITY_LAB_DIR, 'chatgpt-capability-lab-runtime.js');
}

function getUiResourceMeta(): Record<string, unknown> {
    return { ui: { csp: UI_RESOURCE_CSP } };
}

function getChatGptCapabilityLabMeta(): Record<string, unknown> {
    return {
        ui: { csp: UI_RESOURCE_CSP, prefersBorder: true },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen', 'pip'] },
        'openai/widgetDescription': 'Self-test panel for ChatGPT MCP App runtime capabilities in the current conversation.',
        'openai/widgetPrefersBorder': true,
        'openai/widgetCSP': {
            connect_domains: [],
            resource_domains: [],
            redirect_domains: ['https://developers.openai.com'],
        },
    };
}

const READABLE_UI_RESOURCES: Record<string, ReadableUiResource> = {
    [FILE_PREVIEW_RESOURCE_URI]: {
        mimeType: FILE_PREVIEW_RESOURCE.mimeType,
        getText: getFilePreviewResourceText,
        getMeta: getUiResourceMeta
    },
    [CONFIG_EDITOR_RESOURCE_URI]: {
        mimeType: CONFIG_EDITOR_RESOURCE.mimeType,
        getText: getConfigEditorResourceText,
        getMeta: getUiResourceMeta
    },
    [SDK_V2_MRTR_RESOURCE_URI]: {
        mimeType: SDK_V2_MRTR_RESOURCE.mimeType,
        getText: getSdkV2MrtrResourceText,
        getMeta: getUiResourceMeta
    },
    [CHATGPT_CAPABILITY_LAB_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_V6_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_V5_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_V4_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_V3_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_V2_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    },
    [CHATGPT_CAPABILITY_LAB_LEGACY_RESOURCE_URI]: {
        mimeType: CHATGPT_CAPABILITY_LAB_RESOURCE.mimeType,
        getText: getChatGptCapabilityLabResourceText,
        getMeta: getChatGptCapabilityLabMeta
    }
};

export interface UiResourceOptions {
    experimentalMrtr?: boolean;
    chatGptCapabilityLab?: boolean;
}

export function listUiResources(options: UiResourceOptions = {}) {
    return [
        FILE_PREVIEW_RESOURCE,
        CONFIG_EDITOR_RESOURCE,
        ...(options.experimentalMrtr ? [SDK_V2_MRTR_RESOURCE] : []),
        ...(options.chatGptCapabilityLab ? [CHATGPT_CAPABILITY_LAB_RESOURCE] : []),
    ];
}

export async function readUiResource(uri: string, options: UiResourceOptions = {}) {
    if (uri === SDK_V2_MRTR_RESOURCE_URI && !options.experimentalMrtr) {
        return null;
    }
    if (
        (uri === CHATGPT_CAPABILITY_LAB_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V6_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V5_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V4_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V3_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V2_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_LEGACY_RESOURCE_URI) &&
        !options.chatGptCapabilityLab
    ) {
        return null;
    }
    const effectiveUri = uri === SDK_V2_MRTR_RESOURCE_URI && options.experimentalMrtr && options.chatGptCapabilityLab
        ? CHATGPT_CAPABILITY_LAB_RESOURCE_URI
        : uri;
    const resource = READABLE_UI_RESOURCES[effectiveUri];
    if (!resource) {
        return null;
    }

    const resourceText = await resource.getText();
    const resourceMeta = resource.getMeta?.();
    return {
        contents: [
            {
                uri,
                mimeType: resource.mimeType,
                text: resourceText,
                ...(resourceMeta ? { _meta: resourceMeta } : {})
            }
        ]
    };
}
