import path from 'path';
import { Server, acceptedContent, createRequestStateCodec, inputRequired, inputResponse, SUPPORTED_PROTOCOL_VERSIONS, CLIENT_INFO_META_KEY, CLIENT_CAPABILITIES_META_KEY, type Tool } from "@modelcontextprotocol/server";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getSystemInfo, getOSSpecificGuidance, getPathGuidance, getDevelopmentToolGuidance } from './utils/system-info.js';

// Get system information once at startup
const SYSTEM_INFO = getSystemInfo();
const OS_GUIDANCE = getOSSpecificGuidance(SYSTEM_INFO);
const DEV_TOOL_GUIDANCE = getDevelopmentToolGuidance(SYSTEM_INFO);
const PATH_GUIDANCE = `${getPathGuidance(SYSTEM_INFO)} Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.`;

const CMD_PREFIX_DESCRIPTION = `This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.`;

const SERVER_INSTRUCTIONS = `Desktop Commander provides tools for working with the user's authorized device.
- Filesystem tools handle direct file and directory operations within configured access boundaries.
- Terminal process tools support shell commands, REPLs, and long-running processes. Process sessions belong to the current Desktop Commander server instance and are not shared with other Server instances in the same process. start_process creates a session; interact_with_process sends input; read_process_output reads later output; force_terminate ends a session.
- Search sessions belong to the current Desktop Commander server instance and are not shared with other Server instances in the same process. start_search creates a session; get_more_search_results reads its results; stop_search ends it early.
- Absolute paths are generally the most reliable because relative paths depend on the active working directory.
- allowedDirectories and each tool's schema, annotations, and documented constraints define the operational boundaries.`;

import {
    StartProcessArgsSchema,
    ReadProcessOutputArgsSchema,
    InteractWithProcessArgsSchema,
    ForceTerminateArgsSchema,
    ListSessionsArgsSchema,
    KillProcessArgsSchema,
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    GetFileInfoArgsSchema,
    GetConfigArgsSchema,
    SetConfigValueArgsSchema,
    ListProcessesArgsSchema,
    EditBlockArgsSchema,
    GetUsageStatsArgsSchema,
    GiveFeedbackArgsSchema,
    StartSearchArgsSchema,
    GetMoreSearchResultsArgsSchema,
    StopSearchArgsSchema,
    ListSearchesArgsSchema,
    GetRecentToolCallsArgsSchema,
    WritePdfArgsSchema,
    toolArgSchemas,
} from './tools/schemas.js';
import {
    detectUnsupportedParams,
    getSupportedParams,
    buildUnsupportedParamsWarning,
} from './utils/unsupportedParams.js';
import { getConfig, setConfigValue } from './tools/config.js';
import { getUsageStats } from './tools/usage.js';
import { giveFeedbackToDesktopCommander } from './tools/feedback.js';
import { trackToolCall } from './utils/trackTools.js';
import { usageTracker } from './utils/usageTracker.js';
import { processDockerPrompt } from './utils/dockerPrompt.js';
import { toolHistory } from './utils/toolHistory.js';
import { createProcessToolContext } from './tools/improved-process-tools.js';
import { SearchManager } from './search-manager.js';
import { handleWelcomePageOnboarding, skipWelcomePageOnboarding } from './utils/welcome-onboarding.js';

import { VERSION } from './version.js';
import { addToolCallPaths, capture, capture_call_tool, runInUiOriginCallContext, runWithToolCallPaths, runWithTelemetryRequestContext } from "./utils/capture.js";
import { logToStderr, logger } from './utils/logger.js';
import {
    buildUiToolMeta,
    CHATGPT_CAPABILITY_LAB_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI,
    CHATGPT_CAPABILITY_LAB_V6_LEGACY_RESOURCE_URI,
    CONFIG_EDITOR_RESOURCE_URI,
    FILE_PREVIEW_RESOURCE_URI,
    SDK_V2_MRTR_RESOURCE_URI,
} from './ui/contracts.js';
import { getCompressedFilePreviewRuntime, listUiResources, readUiResource } from './ui/resources.js';
import { shouldShowMcpUiPreviews } from './utils/mcp-ui-ab-test.js';

// Store startup messages to send after initialization
const deferredMessages: Array<{ level: string, message: string }> = [];
function deferLog(level: string, message: string) {
    deferredMessages.push({ level, message });
}

// Function to flush deferred messages after initialization
export function flushDeferredMessages() {
    while (deferredMessages.length > 0) {
        const msg = deferredMessages.shift()!;
        logger.info(msg.message);
    }
}

deferLog('info', 'Loading server.ts');

export const SDK_V2_EXPERIMENTAL_MRTR_ENABLED = process.env.DC_SDK_V2_EXPERIMENTAL_MRTR === '1';
export const SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED = process.env.DC_SDK_V2_PLAYGROUND === '1';
export const SDK_V2_MRTR_TOOL_NAME = 'sdk_v2_multi_round_trip_demo';
export const SDK_V2_MRTR_APP_TOOL_NAME = 'sdk_v2_multi_round_trip_demo_app';
export const SDK_V2_MRTR_APP_DECISION_TOOL_NAME = 'sdk_v2_multi_round_trip_demo_app_decide';
export const SDK_V2_CHATGPT_CAPABILITY_LAB_TOOL_NAME = 'sdk_v2_chatgpt_capability_lab';
export const SDK_V2_CHATGPT_CAPABILITY_LAB_ECHO_TOOL_NAME = 'sdk_v2_chatgpt_capability_lab_echo';
export const SDK_V2_CHATGPT_CAPABILITY_LAB_REPORT_TOOL_NAME = 'sdk_v2_chatgpt_capability_lab_report_v6';
export const SDK_V2_CHATGPT_FILE_PARAM_PROBE_TOOL_NAME = 'sdk_v2_chatgpt_file_param_probe';

const sdkV2MrtrStateCodec = SDK_V2_EXPERIMENTAL_MRTR_ENABLED
    ? createRequestStateCodec<{ proposalId: string; round: number }>({ key: randomBytes(32), ttlSeconds: 600 })
    : undefined;

function createSdkV2PlaygroundDiagnostics() {
    return {
        resourceReadCount: 0,
        lastResourceReadUri: null as string | null,
        lastResourceReadAt: null as string | null,
        capabilityReportCount: 0,
        lastCapabilityReport: null as Record<string, unknown> | null,
        lastToolRequestName: null as string | null,
        lastToolRequestMetaKeys: [] as string[],
        lastToolRequestProgressTokenPresent: false,
        lastToolRequestProgressTokenType: null as string | null,
    };
}

function summarizeClientCapabilities(serverInstance: Server = server): Record<string, unknown> | null {
    const capabilities = serverInstance.getClientCapabilities() ?? getServerRuntimeState(serverInstance).clientCapabilities;
    if (!capabilities || typeof capabilities !== 'object') return null;
    const value = capabilities as Record<string, any>;
    const experimental = value.experimental && typeof value.experimental === 'object'
        ? value.experimental as Record<string, unknown>
        : undefined;
    const extensions = value.extensions && typeof value.extensions === 'object'
        ? value.extensions as Record<string, any>
        : undefined;
    const uiExtension = extensions?.['io.modelcontextprotocol/ui'];
    const tasksExtension = extensions?.['io.modelcontextprotocol/tasks'];
    return {
        topLevelKeys: Object.keys(value).sort(),
        experimentalKeys: experimental ? Object.keys(experimental).sort() : [],
        extensionKeys: extensions ? Object.keys(extensions).sort() : [],
        elicitation: value.elicitation && typeof value.elicitation === 'object'
            ? { keys: Object.keys(value.elicitation).sort() }
            : null,
        roots: value.roots && typeof value.roots === 'object'
            ? { keys: Object.keys(value.roots).sort() }
            : null,
        sampling: value.sampling && typeof value.sampling === 'object'
            ? { keys: Object.keys(value.sampling).sort() }
            : null,
        uiExtension: uiExtension && typeof uiExtension === 'object' ? {
            keys: Object.keys(uiExtension).sort(),
            ...(typeof uiExtension.enabled === 'boolean' ? { enabled: uiExtension.enabled } : {}),
            ...(Array.isArray(uiExtension.mimeTypes)
                ? { mimeTypes: uiExtension.mimeTypes.filter((item: unknown): item is string => typeof item === 'string').slice(0, 16) }
                : {}),
        } : null,
        tasksExtension: tasksExtension && typeof tasksExtension === 'object'
            ? { keys: Object.keys(tasksExtension).sort() }
            : null,
    };
}

function getSdkV2PlaygroundDiagnosticsSnapshot(serverInstance: Server = server): Record<string, unknown> {
    const runtimeState = getServerRuntimeState(serverInstance);
    const clientVersion = serverInstance.getClientVersion() ?? runtimeState.clientInfo;
    return {
        ...runtimeState.diagnostics,
        negotiatedProtocolVersion: serverInstance.getNegotiatedProtocolVersion() ?? null,
        clientVersion: clientVersion ? {
            name: clientVersion.name,
            version: clientVersion.version,
            ...('title' in clientVersion && typeof clientVersion.title === 'string' ? { title: clientVersion.title } : {}),
        } : null,
        clientCapabilities: summarizeClientCapabilities(serverInstance),
    };
}

export let server: Server;

// Add handler for resources/list method




// Add handler for prompts/list method


// Store current client info (simple variable)
let currentClient = { name: 'uninitialized', version: 'uninitialized' };
let currentClientCapabilities: Record<string, unknown> | null = null;

interface ServerRuntimeState {
    clientInfo: { name: string; version: string };
    clientCapabilities: Record<string, unknown> | null;
    diagnostics: ReturnType<typeof createSdkV2PlaygroundDiagnostics>;
    processTools?: ReturnType<typeof createProcessToolContext>;
    searchManager?: SearchManager;
}

const serverRuntimeStates = new WeakMap<Server, ServerRuntimeState>();

function getServerRuntimeState(serverInstance: Server): ServerRuntimeState {
    let state = serverRuntimeStates.get(serverInstance);
    if (!state) {
        state = {
            clientInfo: { name: 'uninitialized', version: 'uninitialized' },
            clientCapabilities: null,
            diagnostics: createSdkV2PlaygroundDiagnostics(),
        };
        serverRuntimeStates.set(serverInstance, state);
    }
    return state;
}

function getServerProcessToolContext(serverInstance: Server): ReturnType<typeof createProcessToolContext> {
    const state = getServerRuntimeState(serverInstance);
    return state.processTools ??= createProcessToolContext();
}

function getServerSearchManager(serverInstance: Server): SearchManager {
    const state = getServerRuntimeState(serverInstance);
    return state.searchManager ??= new SearchManager();
}

/**
 * True when this server instance is serving remote services rather than a
 * local MCP client. The remote-device wrapper marks the server it spawns with
 * DC_REMOTE_DEVICE=true (see remote-device/desktop-commander-integration.ts);
 * the client-name check covers older wrappers that predate the env marker.
 */
function isRemoteClientContext(clientName?: string): boolean {
    return process.env.DC_REMOTE_DEVICE === 'true' || clientName === 'desktop-commander-client';
}

/**
 * Unified way to update client information
 */
function updateCurrentClient(serverInstance: Server, clientInfo: { name?: string, version?: string }) {
    const runtimeState = getServerRuntimeState(serverInstance);
    const previousClient = runtimeState.clientInfo;
    if (clientInfo.name !== previousClient.name || clientInfo.version !== previousClient.version) {
        const nameChanged = clientInfo.name !== previousClient.name;
        runtimeState.clientInfo = {
            name: clientInfo.name || previousClient.name,
            version: clientInfo.version || previousClient.version,
        };

        // Keep the exported legacy view and process-global transport integration
        // tied only to the currently exported default Server.
        if (serverInstance === server) {
            currentClient = { ...runtimeState.clientInfo };
            if (nameChanged) {
                const transport = global.mcpTransport;
                if (transport && typeof transport.configureForClient === 'function') {
                    transport.configureForClient(runtimeState.clientInfo.name);
                }
            }
        }
        return true;
    }
    return false;
}

/**
 * Modern stdio requests carry client identity in their validated envelope rather
 * than an initialize handshake. Apply it before dispatch so tools, config,
 * diagnostics and telemetry observe the negotiated client.
 */
function updateCurrentClientFromEnvelope(serverInstance: Server, envelope: any): void {
    if (!envelope || typeof envelope !== 'object') return;
    const runtimeState = getServerRuntimeState(serverInstance);
    const clientInfo = envelope[CLIENT_INFO_META_KEY];
    if (clientInfo && typeof clientInfo === 'object') {
        updateCurrentClient(serverInstance, clientInfo);
    }
    const clientCapabilities = envelope[CLIENT_CAPABILITIES_META_KEY];
    if (clientCapabilities && typeof clientCapabilities === 'object') {
        runtimeState.clientCapabilities = clientCapabilities as Record<string, unknown>;
        if (serverInstance === server) currentClientCapabilities = runtimeState.clientCapabilities;
    }
}

/**
 * Apply Desktop Commander-specific post-initialize state without replacing the
 * SDK's built-in initialize handler. The SDK handler owns protocol negotiation
 * and records client capabilities/version; this hook runs after the client has
 * sent notifications/initialized.
 *
 * The client identity and transport configuration are intentionally synchronous
 * so the first subsequent request sees the correct client-specific tool set.
 * Onboarding is best-effort background work and must not delay that request.
 */
export function handleInitializedClient(serverInstance: Server = server): void {
    const runtimeState = getServerRuntimeState(serverInstance);
    runtimeState.clientCapabilities = serverInstance.getClientCapabilities() as Record<string, unknown> | null;
    const clientInfo = serverInstance.getClientVersion();
    const telemetryContext = {
        client: clientInfo ?? undefined,
        remote: false,
        remoteClient: null,
    };
    if (clientInfo) {
        updateCurrentClient(serverInstance, clientInfo);
        if (serverInstance === server) currentClientCapabilities = runtimeState.clientCapabilities;

        // Welcome page for new users (A/B test controlled) — all clients except
        // the Desktop Commander app and remote contexts. Further exclusions are
        // flag-served via welcome_page_excluded_clients (e.g. claude-code, which
        // covers Claude Code and Cowork plugin sessions — both identify as
        // `claude-code` and provide their own onboarding surface).
        const isWelcomePageEligibleClient = runtimeState.clientInfo.name !== 'desktop-commander-app'
            && runtimeState.clientInfo.name !== 'desktop-commander'
            && !isRemoteClientContext(runtimeState.clientInfo.name)
            && !global.disableOnboarding;

        const onboarding = runWithTelemetryRequestContext(telemetryContext, () => (
            isWelcomePageEligibleClient
                ? handleWelcomePageOnboarding(runtimeState.clientInfo.name)
                : skipWelcomePageOnboarding()
        ));

        void onboarding.catch((error) => {
            logToStderr('error', `Post-initialize onboarding failed: ${error}`);
        });
    }

    // Raw host environment signals (no PII, undefined when absent). Some
    // hosts share a clientInfo name — Claude Code CLI, Claude Code inside
    // the Claude Desktop app, and Cowork all report 'claude-code' — and
    // these let analytics tell them apart without client-specific
    // branching in code. Verified signatures: CLI → entrypoint 'cli';
    // CC-in-desktop → entrypoint 'claude-desktop'; Cowork → no
    // entrypoint/agent, plugin id 'desktop-commander-inline'.
    // Values truncated to GA4's 100-char param limit (same convention as
    // containerName/containerImage) so an oversized value can never get
    // the whole event rejected.
    // Initialization telemetry belongs to this Server instance. A process may
    // create several Servers, so the module-level legacy currentClient fallback
    // can refer to a different instance by the time this hook runs.
    runWithTelemetryRequestContext(telemetryContext, () => {
        capture('run_server_mcp_initialized', {
            host_entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT?.substring(0, 100),
            host_agent: process.env.AI_AGENT?.substring(0, 100),
            host_plugin_id: process.env.CLAUDE_PLUGIN_DATA
                ? path.basename(process.env.CLAUDE_PLUGIN_DATA).substring(0, 100) : undefined
        });
    });
}

// Export current client info for access by other modules
export { currentClient };

deferLog('info', 'Setting up request handlers...');

/**
 * Check if a tool should be included based on current client
 */
function toToolInputSchema(schema: Parameters<typeof zodToJsonSchema>[0]): Tool['inputSchema'] {
    return zodToJsonSchema(schema) as Tool['inputSchema'];
}

function shouldIncludeTool(toolName: string, serverInstance: Server): boolean {
    // Exclude these tools for desktop-commander client (DC-specific meta-tools not useful when DC itself is the client)
    if (getServerRuntimeState(serverInstance).clientInfo.name === 'desktop-commander-app') {
        if (toolName === 'give_feedback_to_desktop_commander') {
            return false;
        }
    }

    // Add more conditional tool logic here as needed
    // Example: if (toolName === 'some_tool' && currentClient?.name === 'some_client') return false;

    return true;
}

function shouldExposeNativeSdkV2Mrtr(serverInstance: Server = server): boolean {
    if (!SDK_V2_EXPERIMENTAL_MRTR_ENABLED) return false;

    // 2026-era clients consume input_required directly. On a 2025-era
    // connection the SDK must fall back to server->client elicitation, so do
    // not advertise the native demo unless the client declared that capability.
    if (serverInstance.getNegotiatedProtocolVersion() === '2026-07-28') return true;
    const capabilities = serverInstance.getClientCapabilities() ?? getServerRuntimeState(serverInstance).clientCapabilities;
    return !!capabilities?.elicitation;
}



import * as handlers from './handlers/index.js';
import { ServerResult } from './types.js';
import { withoutInternalFacts } from './utils/internal-facts.js';
import { stillLoadingError, type FileAction } from './utils/files/index.js';

/**
 * A tool call on an Excel, DOCX or PDF file whose package is still loading
 * after initialize answers at once with this error (utils/files/factory.ts)
 * instead of loading it inside the call. Not sent to telemetry, unlike other
 * errors: it names the file. read_multiple_files answers per file;
 * get_file_info waits for the load, or loads it itself, and so does a search.
 */
function stillLoading(filePath: unknown, action: FileAction, options?: { isPdf?: boolean; isUrl?: boolean }): ServerResult | undefined {
    const error = typeof filePath === 'string' ? stillLoadingError(filePath, action, options) : undefined;
    return error === undefined ? undefined : { content: [{ type: 'text', text: `Error: ${error}` }], isError: true };
}

export async function handleToolsCallRequest(request: CallToolRequest, signal?: AbortSignal, serverInstance: Server = server): Promise<CallToolResult> {
    const args = request.params.arguments;
    // Calls fired programmatically by the widget UIs (file preview, config
    // editor) carry origin:'ui'. They are real tool executions but not agent
    // actions, so they must produce zero telemetry: running them inside the
    // UI-origin capture context makes capture() drop every event they raise
    // (server_call_tool, server_read_file, server_edit_block, ...). Deliberate
    // UI interactions are tracked separately via mcp_ui_event.
    const isUiOriginCall = !!(args && typeof args === 'object' && (args as any).origin === 'ui');
    // Each call keeps the paths it works on, starting with its path arguments,
    // so telemetry can replace them whole in any error text the call produces
    return runWithToolCallPaths(() => {
        addToolCallPaths(...pathArguments(args));
        if (isUiOriginCall) {
            return runInUiOriginCallContext(() => handleCallToolRequest(request, signal, serverInstance));
        }
        return handleCallToolRequest(request, signal, serverInstance);
    }) as Promise<CallToolResult>;
}



/** The values of the tool arguments that hold paths (path, paths, file_path, outputPath, source, destination, shell, ...). */
function pathArguments(args: unknown): unknown[] {
    if (!args || typeof args !== 'object') return [];
    return Object.entries(args)
        .filter(([key]) => /path/i.test(key) || key === 'source' || key === 'destination' || key === 'shell')
        .map(([, value]) => value);
}

async function handleCallToolRequest(request: CallToolRequest, signal?: AbortSignal, serverInstance: Server = server): Promise<ServerResult> {
    const { name, arguments: args } = request.params;
    const processTools = getServerProcessToolContext(serverInstance);
    const searchManager = getServerSearchManager(serverInstance);
    const startTime = Date.now();
    // Hoisted above the try so the finally block can read them when emitting the
    // server_call_tool completion event (duration + status), even on the crash path.
    let telemetryData: any = { tool_name: name };
    let result: ServerResult;
    let isError = false;
    let trackedArgs: any = args;

    try {
        // telemetryData declared above; extract metadata from _meta field if present.
        // Request-scoped telemetry attribution is established by the outer
        // tools/call handler using AsyncLocalStorage before this function runs.
        const metadata = request.params._meta as any;
        const isRemoteCall = !!(metadata && typeof metadata === 'object' && metadata.remote);
        if (isRemoteCall) {
            // add remote flag (convert to string for telemetry)
            telemetryData.remote = String(metadata.remote);
            // Remote calls carry the originating MCP client (e.g. openai-mcp,
            // claude-ai) in _meta.clientInfo. Attribute this call to that remote
            // client — NOT the device's own currentClient. Fall back to a sentinel
            // when it's absent so the call is visibly remote-but-unattributed
            // rather than masquerading as the local device client. We deliberately
            // do NOT call updateCurrentClient here: currentClient tracks the LOCAL
            // client and must not be polluted (nor its transport reconfigured) by
            // remote callers.
            const remoteClient =
                metadata.clientInfo && (metadata.clientInfo.name || metadata.clientInfo.version)
                    ? metadata.clientInfo
                    : { name: 'remote-unknown', version: 'unknown' };
            telemetryData.client_name = remoteClient.name;
            telemetryData.client_version = remoteClient.version;
        }

        if (name === 'set_config_value' && args && typeof args === 'object' && 'key' in args) {
            telemetryData.set_config_value_key_name = (args as any).key;
        }


        if (name === SDK_V2_CHATGPT_FILE_PARAM_PROBE_TOOL_NAME && args?.file && typeof args.file === 'object') {
            trackedArgs = {
                ...args,
                file: {
                    ...(args.file as Record<string, unknown>),
                    download_url: '[redacted]',
                },
            };
        }

        // Track tool call. File-param URLs are ephemeral credentials and are redacted first.
        trackToolCall(name, trackedArgs);

        // Using a more structured approach with dedicated handlers
        // (result is declared above so the finally block can read execution status)

        switch (name) {
            case 'get_file_preview_runtime': {
                // Never accept arbitrary file paths, code or a model-origin request.
                if (args?.origin !== 'ui') {
                    result = { content: [{ type: 'text', text: 'UI-only operation' }], isError: true };
                } else {
                    // This app-only gzip payload must bypass shared prompt mutation, usage tracking, and tool history.
                    return { content: [{ type: 'text', text: await getCompressedFilePreviewRuntime() }] };
                }
                break;
            }
            case SDK_V2_CHATGPT_CAPABILITY_LAB_TOOL_NAME: {
                if (!SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED) {
                    result = { content: [{ type: 'text', text: 'ChatGPT UI capability lab is disabled.' }], isError: true };
                } else {
                    result = {
                        content: [{ type: 'text', text: 'Open the ChatGPT UI capability lab to test conversation-session MCP App features.' }],
                        structuredContent: {
                            status: 'ready',
                            lab: 'chatgpt-ui-capability-lab',
                            version: 9,
                        },
                        _meta: {
                            capabilityLabPrivateMarker: 'widget-only-v9',
                        },
                    };
                    // The Playground is often reloaded while ChatGPT retains the prior tool catalog.
                    // Ask the host to refresh tool/resource metadata after opening the lab so it
                    // resolves the cache-busted v9 Resource URI instead of a stale v8 or older entry.
                    setTimeout(() => {
                        void serverInstance.sendToolListChanged().catch(() => {});
                        void serverInstance.sendResourceListChanged().catch(() => {});
                        void serverInstance.sendResourceUpdated({ uri: CHATGPT_CAPABILITY_LAB_RESOURCE_URI }).catch(() => {});
                        void serverInstance.sendResourceUpdated({ uri: CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI }).catch(() => {});
                        void serverInstance.sendResourceUpdated({ uri: CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI }).catch(() => {});
                        void serverInstance.sendResourceUpdated({ uri: CHATGPT_CAPABILITY_LAB_V6_LEGACY_RESOURCE_URI }).catch(() => {});
                    }, 0);
                }
                break;
            }
            case SDK_V2_CHATGPT_CAPABILITY_LAB_ECHO_TOOL_NAME: {
                const message = typeof args?.message === 'string' ? args.message : '';
                if (!SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED || args?.origin !== 'ui') {
                    result = { content: [{ type: 'text', text: 'UI-only operation' }], isError: true };
                } else if (!message || message.length > 200) {
                    result = { content: [{ type: 'text', text: 'Invalid echo message.' }], isError: true };
                } else {
                    result = {
                        content: [{ type: 'text', text: `Capability lab echo: ${message}` }],
                        structuredContent: { echo: message, source: 'chatgpt-capability-lab' },
                    };
                }
                break;
            }
            case SDK_V2_CHATGPT_CAPABILITY_LAB_REPORT_TOOL_NAME: {
                const windowMethods = Array.isArray(args?.windowMethods)
                    ? args.windowMethods.filter((value): value is string => typeof value === 'string').slice(0, 32)
                    : [];
                const hostCapabilityKeys = Array.isArray(args?.hostCapabilityKeys)
                    ? args.hostCapabilityKeys.filter((value): value is string => typeof value === 'string').slice(0, 32)
                    : [];
                if (!SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED || args?.origin !== 'ui') {
                    result = { content: [{ type: 'text', text: 'UI-only operation' }], isError: true };
                } else {
                    const hostName = typeof args?.hostName === 'string' ? args.hostName.slice(0, 100) : undefined;
                    const hostVersion = typeof args?.hostVersion === 'string' ? args.hostVersion.slice(0, 100) : undefined;
                    const displayMode = typeof args?.displayMode === 'string' ? args.displayMode.slice(0, 40) : undefined;
                    const availableDisplayModes = Array.isArray(args?.availableDisplayModes)
                        ? args.availableDisplayModes.filter((value): value is string => typeof value === 'string').slice(0, 8)
                        : [];
                    const labBuildVersion = args?.labBuildVersion === 6 ? 6 : args?.labBuildVersion === 7 ? 7 : args?.labBuildVersion === 8 ? 8 : args?.labBuildVersion === 9 ? 9 : undefined;
                    const labResourceUri = args?.labResourceUri === CHATGPT_CAPABILITY_LAB_RESOURCE_URI
                        ? CHATGPT_CAPABILITY_LAB_RESOURCE_URI
                        : args?.labResourceUri === CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI
                            ? CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI
                            : args?.labResourceUri === CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI
                                ? CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI
                                : args?.labResourceUri === 'ui://desktop-commander/chatgpt-capability-lab-v6'
                                    ? 'ui://desktop-commander/chatgpt-capability-lab-v6'
                                    : undefined;
                    const layoutValue = args?.layoutDiagnostics && typeof args.layoutDiagnostics === 'object'
                        ? args.layoutDiagnostics as Record<string, unknown>
                        : undefined;
                    const layoutDiagnostics = layoutValue ? {
                        bodyClassName: typeof layoutValue.bodyClassName === 'string' ? layoutValue.bodyClassName.slice(0, 100) : '',
                        bodyMaxHeight: typeof layoutValue.bodyMaxHeight === 'string' ? layoutValue.bodyMaxHeight.slice(0, 40) : '',
                        bodyHeight: typeof layoutValue.bodyHeight === 'number' && Number.isFinite(layoutValue.bodyHeight) ? layoutValue.bodyHeight : 0,
                        bodyScrollHeight: typeof layoutValue.bodyScrollHeight === 'number' && Number.isFinite(layoutValue.bodyScrollHeight) ? layoutValue.bodyScrollHeight : 0,
                        bodyBackgroundColor: typeof layoutValue.bodyBackgroundColor === 'string' ? layoutValue.bodyBackgroundColor.slice(0, 40) : '',
                        bodyColor: typeof layoutValue.bodyColor === 'string' ? layoutValue.bodyColor.slice(0, 40) : '',
                        bodyVisibility: typeof layoutValue.bodyVisibility === 'string' ? layoutValue.bodyVisibility.slice(0, 20) : '',
                        bodyOpacity: typeof layoutValue.bodyOpacity === 'string' ? layoutValue.bodyOpacity.slice(0, 20) : '',
                        documentElementClientHeight: typeof layoutValue.documentElementClientHeight === 'number' && Number.isFinite(layoutValue.documentElementClientHeight) ? layoutValue.documentElementClientHeight : 0,
                        documentElementScrollHeight: typeof layoutValue.documentElementScrollHeight === 'number' && Number.isFinite(layoutValue.documentElementScrollHeight) ? layoutValue.documentElementScrollHeight : 0,
                        windowInnerHeight: typeof layoutValue.windowInnerHeight === 'number' && Number.isFinite(layoutValue.windowInnerHeight) ? layoutValue.windowInnerHeight : 0,
                        cardHeight: typeof layoutValue.cardHeight === 'number' && Number.isFinite(layoutValue.cardHeight) ? layoutValue.cardHeight : 0,
                        cardDisplay: typeof layoutValue.cardDisplay === 'string' ? layoutValue.cardDisplay.slice(0, 40) : '',
                        cardVisibility: typeof layoutValue.cardVisibility === 'string' ? layoutValue.cardVisibility.slice(0, 20) : '',
                        cardOpacity: typeof layoutValue.cardOpacity === 'string' ? layoutValue.cardOpacity.slice(0, 20) : '',
                        cardBackgroundColor: typeof layoutValue.cardBackgroundColor === 'string' ? layoutValue.cardBackgroundColor.slice(0, 40) : '',
                        cardColor: typeof layoutValue.cardColor === 'string' ? layoutValue.cardColor.slice(0, 40) : '',
                        headerHeight: typeof layoutValue.headerHeight === 'number' && Number.isFinite(layoutValue.headerHeight) ? layoutValue.headerHeight : 0,
                        tabsHeight: typeof layoutValue.tabsHeight === 'number' && Number.isFinite(layoutValue.tabsHeight) ? layoutValue.tabsHeight : 0,
                        basicPanelHeight: typeof layoutValue.basicPanelHeight === 'number' && Number.isFinite(layoutValue.basicPanelHeight) ? layoutValue.basicPanelHeight : 0,
                        basicPanelDisplay: typeof layoutValue.basicPanelDisplay === 'string' ? layoutValue.basicPanelDisplay.slice(0, 40) : '',
                        basicPanelVisibility: typeof layoutValue.basicPanelVisibility === 'string' ? layoutValue.basicPanelVisibility.slice(0, 20) : '',
                        basicPanelOpacity: typeof layoutValue.basicPanelOpacity === 'string' ? layoutValue.basicPanelOpacity.slice(0, 20) : '',
                        basicPanelBackgroundColor: typeof layoutValue.basicPanelBackgroundColor === 'string' ? layoutValue.basicPanelBackgroundColor.slice(0, 40) : '',
                        basicPanelColor: typeof layoutValue.basicPanelColor === 'string' ? layoutValue.basicPanelColor.slice(0, 40) : '',
                        basicPanelTextLength: typeof layoutValue.basicPanelTextLength === 'number' && Number.isFinite(layoutValue.basicPanelTextLength) ? layoutValue.basicPanelTextLength : 0,
                        basicPanelChildCount: typeof layoutValue.basicPanelChildCount === 'number' && Number.isFinite(layoutValue.basicPanelChildCount) ? layoutValue.basicPanelChildCount : 0,
                        basicPanelFirstChildTag: typeof layoutValue.basicPanelFirstChildTag === 'string' ? layoutValue.basicPanelFirstChildTag.slice(0, 20) : '',
                        basicPanelFirstChildHeight: typeof layoutValue.basicPanelFirstChildHeight === 'number' && Number.isFinite(layoutValue.basicPanelFirstChildHeight) ? layoutValue.basicPanelFirstChildHeight : 0,
                        basicPanelFirstChildDisplay: typeof layoutValue.basicPanelFirstChildDisplay === 'string' ? layoutValue.basicPanelFirstChildDisplay.slice(0, 40) : '',
                        basicPanelHidden: layoutValue.basicPanelHidden === true,
                        scrollRegionClientHeight: typeof layoutValue.scrollRegionClientHeight === 'number' && Number.isFinite(layoutValue.scrollRegionClientHeight) ? layoutValue.scrollRegionClientHeight : 0,
                        scrollRegionScrollHeight: typeof layoutValue.scrollRegionScrollHeight === 'number' && Number.isFinite(layoutValue.scrollRegionScrollHeight) ? layoutValue.scrollRegionScrollHeight : 0,
                        scrollRegionOverflowY: typeof layoutValue.scrollRegionOverflowY === 'string' ? layoutValue.scrollRegionOverflowY.slice(0, 20) : '',
                        readyState: typeof layoutValue.readyState === 'string' ? layoutValue.readyState.slice(0, 20) : '',
                    } : undefined;
                    const diagnostics = getServerRuntimeState(serverInstance).diagnostics;
                    diagnostics.capabilityReportCount += 1;
                    diagnostics.lastCapabilityReport = {
                        windowMethods,
                        hostCapabilityKeys,
                        ...(labBuildVersion ? { labBuildVersion } : {}),
                        ...(labResourceUri ? { labResourceUri } : {}),
                        ...(layoutDiagnostics ? { layoutDiagnostics } : {}),
                        ...(hostName ? { hostName } : {}),
                        ...(hostVersion ? { hostVersion } : {}),
                        ...(displayMode ? { displayMode } : {}),
                        availableDisplayModes,
                    };
                    result = {
                        content: [{ type: 'text', text: 'Sanitized ChatGPT UI capability report recorded.' }],
                        structuredContent: {
                            status: 'recorded',
                            windowMethodCount: windowMethods.length,
                            hostCapabilityCount: hostCapabilityKeys.length,
                        },
                    };
                }
                break;
            }
            case SDK_V2_CHATGPT_FILE_PARAM_PROBE_TOOL_NAME: {
                const fileValue = args?.file;
                const file = fileValue && typeof fileValue === 'object' ? fileValue as Record<string, unknown> : undefined;
                const fileId = typeof file?.file_id === 'string' ? file.file_id : '';
                const downloadUrl = typeof file?.download_url === 'string' ? file.download_url : '';
                if (!SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED) {
                    result = { content: [{ type: 'text', text: 'ChatGPT file-param probe is disabled.' }], isError: true };
                } else if (!fileId || !downloadUrl) {
                    result = { content: [{ type: 'text', text: 'Invalid ChatGPT file parameter.' }], isError: true };
                } else {
                    const fileName = typeof file?.file_name === 'string' ? file.file_name : null;
                    const mimeType = typeof file?.mime_type === 'string' ? file.mime_type : null;
                    result = {
                        content: [{ type: 'text', text: `ChatGPT file parameter received: ${fileName ?? fileId}. The temporary download URL was not fetched or returned.` }],
                        structuredContent: {
                            fileId,
                            fileName,
                            mimeType,
                            hasDownloadUrl: true,
                        },
                    };
                }
                break;
            }
            case SDK_V2_MRTR_APP_TOOL_NAME: {
                const limits: Record<string, number> = {
                    prompt: 500, detail: 2000, acceptLabel: 80, declineLabel: 80, proposalId: 120,
                };
                const invalidField = Object.entries(args ?? {}).find(([key, value]) =>
                    !Object.prototype.hasOwnProperty.call(limits, key) || typeof value !== 'string' ||
                    Array.from(value).length > limits[key]
                )?.[0];
                if (invalidField) {
                    result = { content: [{ type: 'text', text: `Invalid App input field: ${invalidField}` }], isError: true };
                } else if (!SDK_V2_EXPERIMENTAL_MRTR_ENABLED) {
                    result = { content: [{ type: 'text', text: 'Experimental SDK v2 MRTR App is disabled.' }], isError: true };
                } else {
                    if (SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED) {
                        setTimeout(() => {
                            void serverInstance.sendToolListChanged().catch(() => {});
                            void serverInstance.sendResourceListChanged().catch(() => {});
                            void serverInstance.sendResourceUpdated({ uri: SDK_V2_MRTR_RESOURCE_URI }).catch(() => {});
                        }, 0);
                    }
                    const prompt = typeof args?.prompt === 'string' && args.prompt.trim() ? args.prompt.trim() : 'この提案を承認しますか？';
                    const detail = typeof args?.detail === 'string' && args.detail.trim() ? args.detail.trim() : 'この確認操作自体には副作用がありません。';
                    const acceptLabel = typeof args?.acceptLabel === 'string' && args.acceptLabel.trim() ? args.acceptLabel.trim() : '承認';
                    const declineLabel = typeof args?.declineLabel === 'string' && args.declineLabel.trim() ? args.declineLabel.trim() : '取消';
                    const proposalId = typeof args?.proposalId === 'string' && args.proposalId.trim() ? args.proposalId.trim() : 'sdk-v2-mrtr-demo';
                    result = {
                        content: [{ type: 'text', text: `${prompt}\n${detail}\n選択肢: ${acceptLabel} / ${declineLabel}。App UI が表示されない場合は、どちらを選ぶかテキストで回答してください。` }],
                        structuredContent: {
                            status: 'pending',
                            proposalId,
                            prompt,
                            detail,
                            choices: [{ id: 'accept', label: acceptLabel }, { id: 'decline', label: declineLabel }],
                        },
                    };
                }
                break;
            }
            case SDK_V2_MRTR_APP_DECISION_TOOL_NAME: {
                const action = args?.action;
                if (!SDK_V2_EXPERIMENTAL_MRTR_ENABLED || args?.origin !== 'ui') {
                    result = { content: [{ type: 'text', text: 'UI-only operation' }], isError: true };
                } else if (action !== 'accept' && action !== 'decline') {
                    result = { content: [{ type: 'text', text: 'Invalid App decision.' }], isError: true };
                } else if (
                    Object.keys(args ?? {}).some(key => !['origin', 'action', 'proposalId'].includes(key)) ||
                    (args?.proposalId !== undefined &&
                        (typeof args.proposalId !== 'string' || Array.from(args.proposalId).length > 120))
                ) {
                    result = { content: [{ type: 'text', text: 'Invalid App decision proposalId or arguments.' }], isError: true };
                } else {
                    const proposalId = typeof args?.proposalId === 'string' && args.proposalId.trim() ? args.proposalId.trim() : 'sdk-v2-mrtr-demo';
                    result = {
                        content: [{ type: 'text', text: `Interactive choice complete: ${action}. No changes were made.` }],
                        structuredContent: {
                            status: action,
                            proposalId,
                        },
                    };
                }
                break;
            }
            // Config tools
            case "get_config":
                try {
                    result = await getConfig(getServerRuntimeState(serverInstance).clientInfo);
                    if (SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED && result && typeof result === 'object') {
                        const diagnosticResult = result as Record<string, any>;
                        if (diagnosticResult.structuredContent && typeof diagnosticResult.structuredContent === 'object') {
                            diagnosticResult.structuredContent.playgroundDiagnostics = getSdkV2PlaygroundDiagnosticsSnapshot(serverInstance);
                        }
                        if (Array.isArray(diagnosticResult.content)) {
                            diagnosticResult.content.push({
                                type: 'text',
                                text: `Playground diagnostics:\n${JSON.stringify(getSdkV2PlaygroundDiagnosticsSnapshot(serverInstance), null, 2)}`,
                            });
                        }
                    }
                } catch (error) {
                    capture('server_request_error', { message: `Error in get_config handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to get configuration` }],
                        isError: true,
                    };
                }
                break;
            case "set_config_value":
                try {
                    result = await setConfigValue(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in set_config_value handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to set configuration value` }],
                        isError: true,
                    };
                }
                break;

            case "get_usage_stats":
                try {
                    result = await getUsageStats();
                } catch (error) {
                    capture('server_request_error', { message: `Error in get_usage_stats handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to get usage statistics` }],
                        isError: true,
                    };
                }
                break;

            case "get_recent_tool_calls":
                try {
                    result = await handlers.handleGetRecentToolCalls(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in get_recent_tool_calls handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to get tool call history` }],
                        isError: true,
                    };
                }
                break;

            case "track_ui_event":
                try {
                    result = await handlers.handleTrackUiEvent(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in track_ui_event handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to track UI event` }],
                        isError: true,
                    };
                }
                break;

            case "give_feedback_to_desktop_commander":
                try {
                    result = await giveFeedbackToDesktopCommander(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in give_feedback_to_desktop_commander handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to open feedback form` }],
                        isError: true,
                    };
                }
                break;

            // Terminal tools
            case "start_process":
                result = await handlers.handleStartProcess(args, processTools);
                break;

            case "read_process_output":
                result = await handlers.handleReadProcessOutput(args, processTools);
                break;

            case "interact_with_process":
                result = await handlers.handleInteractWithProcess(args, processTools);
                break;

            case "force_terminate":
                result = await handlers.handleForceTerminate(args, processTools);
                break;

            case "list_sessions":
                result = await handlers.handleListSessions(processTools);
                break;

            // Process tools
            case "list_processes":
                result = await handlers.handleListProcesses();
                break;

            case "kill_process":
                result = await handlers.handleKillProcess(args, processTools);
                break;

            // Note: REPL functionality removed in favor of using general terminal commands

            // Filesystem tools
            case "read_file":
                result = stillLoading(args?.path, 'read', { isUrl: args?.isUrl === true }) ?? await handlers.handleReadFile(args, signal);
                break;

            case "read_multiple_files":
                result = await handlers.handleReadMultipleFiles(args, (filePath) => stillLoadingError(filePath, 'read'));
                break;

            case "write_file":
                result = stillLoading(args?.path, 'write') ?? await handlers.handleWriteFile(args);
                break;

            case "write_pdf": {
                // Markdown (a new PDF) or page edits, read as the tool reads them;
                // arguments the tool refuses get its own error
                const parsed = WritePdfArgsSchema.safeParse(args);
                const action = parsed.success && typeof parsed.data.content === 'string' ? 'write' : 'edit';
                result = (parsed.success ? stillLoading(parsed.data.path, action, { isPdf: true }) : undefined) ?? await handlers.handleWritePdf(args);
                break;
            }

            case "create_directory":
                result = await handlers.handleCreateDirectory(args);
                break;

            case "list_directory":
                result = await handlers.handleListDirectory(args);
                break;

            case "move_file":
                result = await handlers.handleMoveFile(args);
                break;

            case "start_search":
                result = await handlers.handleStartSearch(args, searchManager);
                break;

            case "get_more_search_results":
                result = await handlers.handleGetMoreSearchResults(args, searchManager);
                break;

            case "stop_search":
                result = await handlers.handleStopSearch(args, searchManager);
                break;

            case "list_searches":
                result = await handlers.handleListSearches(searchManager);
                break;

            case "get_file_info":
                result = await handlers.handleGetFileInfo(args);
                break;

            case "edit_block":
                result = stillLoading(args?.file_path, 'edit') ?? await handlers.handleEditBlock(args);
                break;

            default:
                capture('server_unknown_tool', { name });
                result = {
                    content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
                    isError: true,
                };
        }

        // What the client receives (and the history records): facts kept internal are dropped
        result = withoutInternalFacts(name, result);

        // Add tool call to history (exclude only get_recent_tool_calls to prevent recursion)
        const duration = Date.now() - startTime;
        isError = !!result.isError;
        const EXCLUDED_TOOLS = [
            'get_recent_tool_calls',
            'track_ui_event'
        ];

        if (!EXCLUDED_TOOLS.includes(name)) {
            toolHistory.addCall(name, trackedArgs, result, duration);
        }

        // Track success or failure based on result
        if (name === 'track_ui_event') {
            return result;
        }

        if (result.isError) {
            await usageTracker.trackFailure(name);
            console.log(`[FEEDBACK DEBUG] Tool ${name} failed, not checking feedback`);
        } else {
            await usageTracker.trackSuccess(name);
            console.log(`[FEEDBACK DEBUG] Tool ${name} succeeded, checking feedback...`);

            // Check if should prompt for feedback (only on successful operations)
            const shouldPrompt = await usageTracker.shouldPromptForFeedback(getServerRuntimeState(serverInstance).clientInfo);
            console.log(`[FEEDBACK DEBUG] Should prompt for feedback: ${shouldPrompt}`);

            if (shouldPrompt) {
                console.log(`[FEEDBACK DEBUG] Generating feedback message...`);
                const feedbackResult = await usageTracker.getFeedbackPromptMessage();
                console.log(`[FEEDBACK DEBUG] Generated variant: ${feedbackResult.variant}`);

                // Capture feedback prompt injection event
                const stats = await usageTracker.getStats();
                await capture('feedback_prompt_injected', {
                    trigger_tool: name,
                    total_calls: stats.totalToolCalls,
                    successful_calls: stats.successfulCalls,
                    failed_calls: stats.failedCalls,
                    days_since_first_use: Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24)),
                    total_sessions: stats.totalSessions,
                    message_variant: feedbackResult.variant
                });

                // Inject feedback instruction for the LLM
                if (result.content && result.content.length > 0 && result.content[0].type === "text") {
                    const currentContent = result.content[0].text || '';
                    result.content[0].text = `${currentContent}${feedbackResult.message}`;
                } else {
                    result.content = [
                        ...(result.content || []),
                        {
                            type: "text",
                            text: feedbackResult.message
                        }
                    ];
                }

                // Mark that we've prompted (to prevent spam)
                await usageTracker.markFeedbackPrompted();
            }

            // Check if should prompt about Docker environment
            result = await processDockerPrompt(result, name, getServerRuntimeState(serverInstance).clientInfo);
        }

        // If the caller sent parameters this tool does not support, Zod silently
        // strips them. Prepend a corrective warning so the model knows they were
        // ignored and which parameters are actually supported.
        try {
            const argSchema = toolArgSchemas[name];
            if (argSchema && result && Array.isArray((result as any).content)) {
                const unsupported = detectUnsupportedParams(args, argSchema);
                if (unsupported.length > 0) {
                    const warning = buildUnsupportedParamsWarning(
                        name, unsupported, getSupportedParams(argSchema)
                    );
                    (result as any).content = [
                        { type: "text", text: warning },
                        ...(result as any).content,
                    ];
                }
            }
        } catch {
            // Never let the advisory warning break an otherwise-successful call.
        }

        return result;
    } catch (error) {
        isError = true;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Track the failure
        await usageTracker.trackFailure(name);

        capture('server_request_error', {
            error: errorMessage
        });
        return {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            isError: true,
        };
    } finally {
        // Single tool-call telemetry event, fired AFTER execution so it can carry
        // timing. In a finally so it still fires on the hard-crash path (the catch
        // above). Only missed if a tool never returns or throws (a true hang).
        // Not emitted for track_ui_event (it is just the transport for
        // mcp_ui_event) — and UI-origin calls are dropped wholesale by the
        // capture layer, so server_call_tool reflects only genuine
        // agent-driven tool calls.
        if (name !== 'track_ui_event') {
            capture_call_tool('server_call_tool', {
                ...telemetryData,
                duration_ms: Date.now() - startTime,
                is_error: String(isError),
            });
        }
    }
}

// Add no-op handlers so Visual Studio initialization succeeds

/**
 * Register the complete Desktop Commander request surface on one Server instance.
 * serveStdio calls the factory again when it discards a modern discovery probe
 * and falls back to the legacy initialize handshake.
 */
function registerServerHandlers(targetServer: Server): void {
targetServer.setRequestHandler('resources/list', async (_request, ctx) => {
    updateCurrentClientFromEnvelope(targetServer, ctx.mcpReq.envelope);
    return {
        resources: listUiResources({
            experimentalMrtr: SDK_V2_EXPERIMENTAL_MRTR_ENABLED,
            chatGptCapabilityLab: SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED,
        }),
    };
});

targetServer.setRequestHandler('resources/read', async (request, ctx) => {
    updateCurrentClientFromEnvelope(targetServer, ctx.mcpReq.envelope);
    const { uri } = request.params;
    if (SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED) {
        const diagnostics = getServerRuntimeState(targetServer).diagnostics;
        diagnostics.resourceReadCount += 1;
        diagnostics.lastResourceReadUri = uri;
        diagnostics.lastResourceReadAt = new Date().toISOString();
    }
    const response = await readUiResource(uri, {
        experimentalMrtr: SDK_V2_EXPERIMENTAL_MRTR_ENABLED,
        chatGptCapabilityLab: SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED,
    });
    if (response) {
        if (
            uri === CHATGPT_CAPABILITY_LAB_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V8_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V7_LEGACY_RESOURCE_URI ||
            uri === CHATGPT_CAPABILITY_LAB_V6_LEGACY_RESOURCE_URI
        ) {
            return { ...response, ttlMs: 60_000, cacheScope: 'private' };
        }
        return response;
    }

    throw new Error(`Unknown resource URI: ${uri}`);
});

targetServer.setRequestHandler('prompts/list', async (_request, ctx) => {
    updateCurrentClientFromEnvelope(targetServer, ctx.mcpReq.envelope);
    // Return an empty list of prompts
    return {
        prompts: [],
    };
});

targetServer.setRequestHandler('tools/list', async (_request, ctx) => {
    updateCurrentClientFromEnvelope(targetServer, ctx.mcpReq.envelope);
    try {
        // logToStderr('debug', 'Generating tools list...');
        const showMcpUiPreviews = await shouldShowMcpUiPreviews();

        // Build complete tools array
        const allTools = [
            // Internal viewer runtime: accessible to MCP Apps, not to the model.
            {
                name: 'get_file_preview_runtime',
                description: 'Load the fixed, compressed Desktop Commander viewer runtime after a preview click.',
                inputSchema: {
                    type: 'object',
                    properties: { origin: { type: 'string', enum: ['ui'] } },
                    required: ['origin'],
                    additionalProperties: false,
                } as Tool['inputSchema'],
                _meta: { ui: { visibility: ['app'] } },
                annotations: { title: 'Load Preview Viewer', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
            },
            ...(SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED ? [{
                name: SDK_V2_CHATGPT_CAPABILITY_LAB_TOOL_NAME,
                description: 'Open a side-effect-free ChatGPT conversation UI capability lab for MCP Apps/runtime features. Intended only for the isolated SDK v2 playground.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                } as Tool['inputSchema'],
                outputSchema: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', enum: ['ready'] },
                        lab: { type: 'string', enum: ['chatgpt-ui-capability-lab'] },
                        version: { type: 'number', enum: [9] },
                    },
                    required: ['status', 'lab', 'version'],
                    additionalProperties: false,
                },
                _meta: {
                    ...(buildUiToolMeta(CHATGPT_CAPABILITY_LAB_RESOURCE_URI, true, true) ?? {}),
                    'openai/toolInvocation/invoking': 'Opening capability lab…',
                    'openai/toolInvocation/invoked': 'Capability lab ready',
                },
                annotations: {
                    title: 'ChatGPT UI Capability Lab',
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                    idempotentHint: true,
                },
            }, {
                name: SDK_V2_CHATGPT_CAPABILITY_LAB_ECHO_TOOL_NAME,
                description: 'App-only echo endpoint for the ChatGPT UI capability lab. No side effects.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        origin: { type: 'string', enum: ['ui'] },
                        message: { type: 'string', maxLength: 200 },
                    },
                    required: ['origin', 'message'],
                    additionalProperties: false,
                } as Tool['inputSchema'],
                outputSchema: {
                    type: 'object',
                    properties: {
                        echo: { type: 'string' },
                        source: { type: 'string', enum: ['chatgpt-capability-lab'] },
                    },
                    required: ['echo', 'source'],
                    additionalProperties: false,
                },
                _meta: { ui: { visibility: ['app'] } },
                annotations: {
                    title: 'ChatGPT UI Capability Lab Echo',
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                    idempotentHint: true,
                },
            }, {
                name: SDK_V2_CHATGPT_CAPABILITY_LAB_REPORT_TOOL_NAME,
                description: 'App-only sanitized host capability report for the ChatGPT UI capability lab. No side effects and no secrets.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        origin: { type: 'string', enum: ['ui'] },
                        labBuildVersion: { type: 'integer', enum: [6] },
                        labResourceUri: { type: 'string', enum: [CHATGPT_CAPABILITY_LAB_V6_LEGACY_RESOURCE_URI] },
                        layoutDiagnostics: {
                            type: 'object',
                            properties: {
                                bodyClassName: { type: 'string', maxLength: 100 },
                                bodyMaxHeight: { type: 'string', maxLength: 40 },
                                bodyHeight: { type: 'number' },
                                bodyScrollHeight: { type: 'integer' },
                                bodyBackgroundColor: { type: 'string', maxLength: 40 },
                                bodyColor: { type: 'string', maxLength: 40 },
                                bodyVisibility: { type: 'string', maxLength: 20 },
                                bodyOpacity: { type: 'string', maxLength: 20 },
                                documentElementClientHeight: { type: 'integer' },
                                documentElementScrollHeight: { type: 'integer' },
                                windowInnerHeight: { type: 'integer' },
                                cardHeight: { type: 'integer' },
                                cardDisplay: { type: 'string', maxLength: 40 },
                                cardVisibility: { type: 'string', maxLength: 20 },
                                cardOpacity: { type: 'string', maxLength: 20 },
                                cardBackgroundColor: { type: 'string', maxLength: 40 },
                                cardColor: { type: 'string', maxLength: 40 },
                                headerHeight: { type: 'integer' },
                                tabsHeight: { type: 'integer' },
                                basicPanelHeight: { type: 'integer' },
                                basicPanelDisplay: { type: 'string', maxLength: 40 },
                                basicPanelVisibility: { type: 'string', maxLength: 20 },
                                basicPanelOpacity: { type: 'string', maxLength: 20 },
                                basicPanelBackgroundColor: { type: 'string', maxLength: 40 },
                                basicPanelColor: { type: 'string', maxLength: 40 },
                                basicPanelTextLength: { type: 'integer' },
                                basicPanelChildCount: { type: 'integer' },
                                basicPanelFirstChildTag: { type: 'string', maxLength: 20 },
                                basicPanelFirstChildHeight: { type: 'integer' },
                                basicPanelFirstChildDisplay: { type: 'string', maxLength: 40 },
                                basicPanelHidden: { type: 'boolean' },
                                scrollRegionClientHeight: { type: 'integer' },
                                scrollRegionScrollHeight: { type: 'integer' },
                                scrollRegionOverflowY: { type: 'string', maxLength: 20 },
                                readyState: { type: 'string', maxLength: 20 },
                            },
                            required: [
                                'bodyClassName', 'bodyMaxHeight', 'bodyHeight', 'bodyScrollHeight',
                                'bodyBackgroundColor', 'bodyColor', 'bodyVisibility', 'bodyOpacity',
                                'documentElementClientHeight', 'documentElementScrollHeight', 'windowInnerHeight',
                                'cardHeight', 'cardDisplay', 'cardVisibility', 'cardOpacity', 'cardBackgroundColor', 'cardColor',
                                'headerHeight', 'tabsHeight', 'basicPanelHeight', 'basicPanelDisplay',
                                'basicPanelVisibility', 'basicPanelOpacity', 'basicPanelBackgroundColor', 'basicPanelColor',
                                'basicPanelTextLength', 'basicPanelChildCount', 'basicPanelFirstChildTag',
                                'basicPanelFirstChildHeight', 'basicPanelFirstChildDisplay', 'basicPanelHidden',
                                'scrollRegionClientHeight', 'scrollRegionScrollHeight', 'scrollRegionOverflowY', 'readyState',
                            ],
                            additionalProperties: false,
                        },
                        windowMethods: { type: 'array', items: { type: 'string' }, maxItems: 32 },
                        hostCapabilityKeys: { type: 'array', items: { type: 'string' }, maxItems: 32 },
                        hostName: { type: 'string', maxLength: 100 },
                        hostVersion: { type: 'string', maxLength: 100 },
                        displayMode: { type: 'string', maxLength: 40 },
                        availableDisplayModes: { type: 'array', items: { type: 'string' }, maxItems: 8 },
                    },
                    required: ['origin', 'windowMethods', 'hostCapabilityKeys'],
                    additionalProperties: false,
                } as Tool['inputSchema'],
                outputSchema: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', enum: ['recorded'] },
                        windowMethodCount: { type: 'integer' },
                        hostCapabilityCount: { type: 'integer' },
                    },
                    required: ['status', 'windowMethodCount', 'hostCapabilityCount'],
                    additionalProperties: false,
                },
                _meta: { ui: { visibility: ['app'] } },
                annotations: {
                    title: 'ChatGPT UI Capability Lab Report',
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                    idempotentHint: true,
                },
            }, {
                name: SDK_V2_CHATGPT_FILE_PARAM_PROBE_TOOL_NAME,
                description: 'Read-only probe for ChatGPT file parameters. Reports file metadata and whether a download URL was supplied, but never fetches or returns the URL.',
                inputSchema: {
                    type: 'object',
                    $defs: {
                        OpenAIFile: {
                            type: 'object',
                            properties: {
                                download_url: { type: 'string' },
                                file_id: { type: 'string' },
                                mime_type: { type: 'string' },
                                file_name: { type: 'string' },
                            },
                            required: ['download_url', 'file_id'],
                            additionalProperties: false,
                        },
                    },
                    properties: { file: { $ref: '#/$defs/OpenAIFile' } },
                    required: ['file'],
                    additionalProperties: false,
                } as Tool['inputSchema'],
                outputSchema: {
                    type: 'object',
                    properties: {
                        fileId: { type: 'string' },
                        fileName: { type: ['string', 'null'] },
                        mimeType: { type: ['string', 'null'] },
                        hasDownloadUrl: { type: 'boolean' },
                    },
                    required: ['fileId', 'fileName', 'mimeType', 'hasDownloadUrl'],
                    additionalProperties: false,
                },
                _meta: {
                    'openai/fileParams': ['file'],
                    'openai/toolInvocation/invoking': 'Inspecting file parameter…',
                    'openai/toolInvocation/invoked': 'File parameter inspected',
                },
                annotations: {
                    title: 'ChatGPT File Parameter Probe',
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                    idempotentHint: true,
                },
            }] : []),
            ...(SDK_V2_EXPERIMENTAL_MRTR_ENABLED ? [
                ...(shouldExposeNativeSdkV2Mrtr(targetServer) ? [{
                    name: SDK_V2_MRTR_TOOL_NAME,
                    description: 'Experimental SDK v2 multi-round-trip confirmation demo. It has no side effects: it asks the client to approve or decline a proposal, then returns the verified choice.',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                        additionalProperties: false,
                    } as Tool['inputSchema'],
                    annotations: {
                        title: 'SDK v2 Multi-Round-Trip Demo',
                        readOnlyHint: true,
                        openWorldHint: false,
                        destructiveHint: false,
                    },
                }] : []),
                {
                name: SDK_V2_MRTR_APP_TOOL_NAME,
                description: 'Open an MCP App for a side-effect-free interactive choice. Supports reusable labels/text and a text fallback when App UI is unavailable. This is a UI fallback for hosts that do not yet negotiate the 2026 protocol.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        prompt: { type: 'string', maxLength: 500 },
                        detail: { type: 'string', maxLength: 2000 },
                        acceptLabel: { type: 'string', maxLength: 80 },
                        declineLabel: { type: 'string', maxLength: 80 },
                        proposalId: { type: 'string', maxLength: 120 },
                    },
                    additionalProperties: false,
                } as Tool['inputSchema'],
                _meta: buildUiToolMeta(SDK_V2_MRTR_RESOURCE_URI, true, true),
                annotations: {
                    title: 'SDK v2 Multi-Round-Trip App Demo',
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            }, {
                name: SDK_V2_MRTR_APP_DECISION_TOOL_NAME,
                description: 'Record an approve/decline choice from the SDK v2 multi-round-trip demo App. App-only and side-effect-free.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        origin: { type: 'string', enum: ['ui'] },
                        action: { type: 'string', enum: ['accept', 'decline'] },
                        proposalId: { type: 'string', maxLength: 120 },
                    },
                    required: ['origin', 'action'],
                    additionalProperties: false,
                } as Tool['inputSchema'],
                _meta: { ui: { visibility: ['app'] } },
                annotations: {
                    title: 'SDK v2 Multi-Round-Trip App Decision',
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            }] : []),
            // Configuration tools
            {
                name: "get_config",
                description: `
                        Get the complete server configuration as JSON. Config includes fields for:
                        - blockedCommands (array of blocked shell commands)
                        - defaultShell (shell to use for commands)
                        - allowedDirectories (paths the server can access)
                        - fileReadLineLimit (max lines for read_file, default 1000)
                        - fileWriteLineLimit (advisory line threshold for write content/edit blocks; operations above it are still allowed, default 50)
                        - telemetryEnabled (boolean for telemetry opt-in/out)
                        - currentClient (information about the currently connected MCP client)
                        - clientHistory (history of all clients that have connected)
                        - version (version of the DesktopCommander)
                        - systemInfo (operating system and environment details)
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(GetConfigArgsSchema),
                _meta: buildUiToolMeta(CONFIG_EDITOR_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Get Configuration",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "set_config_value",
                description: `
                        Set a specific configuration value by key.

                        Security note: configuration changes affect later file and command behavior.
                        Isolating them from untrusted file or command content reduces the chance that external content influences configuration.

                        Config keys include:
                        - blockedCommands (array)
                        - defaultShell (string)
                        - allowedDirectories (array of paths)
                        - fileReadLineLimit (number, max lines for read_file)
                        - fileWriteLineLimit (number, advisory line threshold for write content/edit blocks; operations above it are still allowed)
                        - telemetryEnabled (boolean)

                        IMPORTANT: Setting allowedDirectories to an empty array ([]) allows full access
                        to the entire file system, regardless of the operating system.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(SetConfigValueArgsSchema),
                annotations: {
                    title: "Set Configuration Value",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },

            // Filesystem tools
            {
                name: "read_file",
                description: `
                        Read contents from files and URLs.
                        Read PDF files and extract content as markdown and images.

                        Suitable for reading authorized local files directly without starting a shell command.

                        PREVIEW ORIGIN:
                        - 'origin: "ui"' is reserved for the File Preview app's own refresh/navigation calls.
                        - MCP hosts may surface those UI-origin calls to the model as preview metadata rather than file body content.
                        - For file content in model context, omit 'origin' (the normal model call) or use 'origin: "llm"'.

                        Supports partial file reading with:
                        - 'offset' (start line, default: 0)
                          * Positive: Start from line N (0-based indexing)
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting, initially 1000)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail lines)

                        Examples:
                        - offset: 0, length: 10     → First 10 lines
                        - offset: 100, length: 5    → Lines 100-104
                        - offset: -20               → Last 20 lines
                        - offset: -5, length: 10    → Last 5 lines (length ignored)

                        Performance optimizations:
                        - Large files with negative offsets use reverse reading for efficiency
                        - Large files with deep positive offsets use byte estimation
                        - Small files use fast readline streaming

                        EXACT-CONTENT LIMITS:
                        - Text reads are decoded, line-oriented views, not the original file bytes.
                        - LF, CRLF, and lone CR line endings are returned as \n, and a final line terminator is not preserved.
                        - UTF-16LE files with a BOM are decoded without returning that BOM, so source encoding/BOM cannot generally be reconstructed.
                        - There is no general-purpose raw-byte or Base64 mode for arbitrary files. Supported image files are a format-specific exception.
                        - For byte-exact verification, prefer a local hash or comparison with start_process rather than transporting file bytes through process output.
                        - Pagination status can include total/remaining lines for smaller text files; larger files may omit totals, so it is not a complete-file proof.

                        When reading from the file system, only works within allowed directories.
                        Can fetch content from URLs when isUrl parameter is set to true
                        (URLs are always read in full regardless of offset/length).

                        FORMAT HANDLING (by extension):
                        - Text: Uses offset/length for line-based pagination
                        - Excel (.xlsx, .xls, .xlsm): Returns JSON 2D array
                          * sheet: "Sheet1" (name) or "0" (index as string, 0-based)
                          * range uses FROM:TO format (e.g., "A1:D100", "C1:C1", "B2:B50")
                          * offset/length work as row pagination (optional fallback)
                        - Images (PNG, JPEG, GIF, WebP): Base64 encoded viewable content
                        - PDF: Extracts text content as markdown with page structure
                          * offset/length work as page pagination (0-based)
                          * Includes embedded images when available
                        - DOCX (.docx): Two modes depending on parameters:
                          * DEFAULT (no offset/length): Returns a text-bearing outline — shows paragraphs with text,
                            tables with cell content, styles, image refs. Skips shapes/drawings/SVG noise.
                            Each element shows its body index [0], [1], etc.
                          * WITH offset/length: Returns raw pretty-printed XML with line pagination.
                            Use this to drill into specific sections or see the actual XML for editing.
                          * Raw DOCX XML output is compatible with edit_block's XML find/replace mode using
                            XML fragments copied from the read output.
                          * Raw XML mode requires a non-zero offset (offset=1 starts from line 1).
                            offset=0 returns the outline regardless of length.
                          * Bulk transformations can be performed programmatically against the DOCX archive
                            when the task requires changes across many XML text nodes.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ReadFileArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Read File or URL",
                    readOnlyHint: true,
                    openWorldHint: true,
                    destructiveHint: false,
                },
            },
            {
                name: "read_multiple_files",
                description: `
                        Read the contents of multiple files simultaneously.

                        Each file's content is returned with its path as a reference.
                        Handles text files normally and renders images as viewable content.
                        Recognized image types: PNG, JPEG, GIF, WebP.

                        Text items have the same decoded, line-oriented representation as read_file; they do not
                        preserve original newline style, a final line terminator, or UTF-16LE BOM presence, and
                        there is no general-purpose raw-byte/Base64 mode for arbitrary files. This tool has no
                        per-file offset/length arguments, so each text item uses the configured default read limit.
                        For smaller text files the embedded read status can report total/remaining lines; larger
                        files can omit totals, so the response alone is not a complete-file proof. For byte-exact
                        verification, prefer a local hash or comparison with start_process.

                        Failed reads for individual files won't stop the entire operation.
                        Only works within allowed directories.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ReadMultipleFilesArgsSchema),
                annotations: {
                    title: "Read Multiple Files",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "write_file",
                description: `
                        Write or append to file contents.

                        PDF creation is handled by the dedicated write_pdf tool.
                        Existing DOCX content can be edited with edit_block. New DOCX files can be created here; markdown headings (#, ##, ###) are converted to styled DOCX paragraphs.

                        CHUNKED WRITES:
                        - Repeated calls with mode='rewrite' followed by mode='append' are supported for longer files.
                        - Chunks of roughly 25-30 lines minimize latency when writing long text, multiple files, documentation, code, or configuration files.
                        - Files over 50 lines are still written successfully but may generate performance notes.
                        - For continuation after a partial write, the existing file state can be inspected before appending the remaining content.

                        FORMAT HANDLING (by extension):
                        - Text files: String content
                        - Excel (.xlsx, .xls, .xlsm): JSON 2D array or {"SheetName": [[...]]}
                          Example: '[["Name","Age"],["Alice",30]]'

                        Only works within allowed directories.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(WriteFileArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Write File",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "write_pdf",
                description: `
                        Create a new PDF file or modify an existing one.

                        Dedicated PDF creation and modification tool.

                        OUTPUT FILES:
                        - Creating a PDF requires 'outputPath' with a new filename (e.g., "result_01.pdf", "analysis_2025_01.pdf", etc.).

                        MODES:
                        1. CREATE NEW PDF:
                           - Pass a markdown string as 'content'.
                           write_pdf(path="doc.pdf", content="# Title\\n\\nBody text...")

                        2. MODIFY EXISTING PDF:
                           - Pass array of operations as 'content'.
                           - Modifications preserve the original PDF and require a different filename in 'outputPath'.
                           - The result includes the original and output paths for reference.

                           write_pdf(path="doc.pdf", content=[
                               { type: "delete", pageIndexes: [0, 2] },
                               { type: "insert", pageIndex: 1, markdown: "# New Page" }
                           ])

                        OPERATIONS:
                        - delete: Remove pages by 0-based index.
                          { type: "delete", pageIndexes: [0, 1, 5] }

                        - insert: Add pages at a specific 0-based index.
                          { type: "insert", pageIndex: 0, markdown: "..." }
                          { type: "insert", pageIndex: 5, sourcePdfPath: "/path/to/source.pdf" }

                        PAGE BREAKS:
                        To force a page break, use this HTML element:
                        <div style="page-break-before: always;"></div>

                        Example:
                        "# Page 1\\n\\n<div style=\\"page-break-before: always;\\"></div>\\n\\n# Page 2"

                        ADVANCED STYLING:
                        HTML/CSS and inline SVG are supported for:
                        - Text styling: colors, sizes, alignment, highlights
                        - Boxes: borders, backgrounds, padding, rounded corners
                        - SVG graphics: charts, diagrams, icons, shapes
                        - Images: <img src="/absolute/path/image.jpg" width="300" /> or ![alt](/path/image.jpg)

                        Supports standard markdown features including headers, lists, code blocks, tables, and basic formatting.

                        Only works within allowed directories.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(WritePdfArgsSchema),
                annotations: {
                    title: "Write/Modify PDF",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "create_directory",
                description: `
                        Create a new directory or ensure a directory exists.

                        Can create multiple nested directories in one operation.
                        Only works within allowed directories.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(CreateDirectoryArgsSchema),
                annotations: {
                    title: "Create Directory",
                    readOnlyHint: false,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "list_directory",
                description: `
                        Get a detailed listing of all files and directories in a specified path.

                        Returns a structured directory listing without starting a shell command.
                        Results distinguish between files and directories with [FILE] and [DIR] prefixes.

                        Supports recursive listing with the 'depth' parameter (default: 2):
                        - depth=1: Only direct contents of the directory
                        - depth=2: Contents plus one level of subdirectories
                        - depth=3+: Multiple levels deep

                        CONTEXT OVERFLOW PROTECTION:
                        - Top-level directory shows ALL items
                        - Nested directories are limited to 100 items maximum per directory
                        - When a nested directory has more than 100 items, you'll see a warning like:
                          [WARNING] node_modules: 500 items hidden (showing first 100 of 600 total)
                        - This prevents overwhelming the context with large directories like node_modules

                        Results show full relative paths from the root directory being listed.
                        Example output with depth=2:
                        [DIR] src
                        [FILE] src/index.ts
                        [DIR] src/tools
                        [FILE] src/tools/filesystem.ts

                        If a directory cannot be accessed, it will show [DENIED] instead.
                        If a path does not exist, it will show [NOT_FOUND] instead.
                        Only works within allowed directories.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ListDirectoryArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "List Directory Contents",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "move_file",
                description: `
                        Move or rename files and directories.

                        Can move files between directories and rename them in a single operation.
                        Both source and destination must be within allowed directories.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(MoveFileArgsSchema),
                annotations: {
                    title: "Move/Rename File",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "start_search",
                description: `
                        Start a streaming search that can return results progressively.

                        SEARCH STRATEGY GUIDE:
                        Choose the right search type based on what the user is looking for:

                        USE searchType="files" WHEN:
                        - User asks for specific files: "find package.json", "locate config files"
                        - Pattern looks like a filename: "*.js", "README.md", "test-*.tsx"
                        - User wants to find files by name/extension: "all TypeScript files", "Python scripts"
                        - Looking for configuration/setup files: ".env", "dockerfile", "tsconfig.json"

                        USE searchType="content" WHEN:
                        - User asks about code/logic: "authentication logic", "error handling", "API calls"
                        - Looking for functions/variables: "getUserData function", "useState hook"
                        - Searching for text/comments: "TODO items", "FIXME comments", "documentation"
                        - Finding patterns in code: "console.log statements", "import statements"
                        - User describes functionality: "components that handle login", "files with database queries"

                        AMBIGUOUS SEARCHES:
                        Queries that could refer to either filenames or file contents can be covered with two
                        searches: one with searchType="files" and one with searchType="content".
                        Example: "find authentication stuff" can pair a filename search for "auth" with a
                        content search for "authentication".

                        SEARCH TYPES:
                        - searchType="files": Find files by name (pattern matches file names)
                        - searchType="content": Search inside files for text patterns

                        PATTERN MATCHING MODES:
                        - File-name search (searchType="files") is glob-based, not regex-based:
                          - pattern="package.json" → exact filename match
                          - pattern="*.ts" → glob match
                          - pattern="auth" → filename substring match
                          - pattern="report[1].txt", literalSearch=true → treats [ and ] as literal filename characters
                        - With literalSearch=false, glob-looking file patterns use glob syntax; plain names are substrings.
                        - With literalSearch=true, glob metacharacters in file-name patterns are treated literally.
                        - Text content search uses regular expressions by default and fixed-string matching when
                          literalSearch=true.
                        - Excel and DOCX content search is always literal substring matching, regardless of
                          literalSearch, to avoid unsafe regular-expression evaluation in document content.

                        Do not use regex syntax for file-name searches. For example, pattern="target-.*\\.txt$"
                        is not a filename regex; use an appropriate glob such as pattern="target-*.txt" instead.

                        IMPORTANT PARAMETERS:
                        - pattern: What to search for (file names OR content text)
                        - literalSearch: Controls literal matching as described above (default: false)
                        - filePattern: Optional glob filter; supports | separated alternatives and ripgrep-style ! exclusions (e.g., "*.js|*.ts|!*.test.ts")
                        - ignoreCase: Case-insensitive search (default: true). Works for both file names and content.
                        - earlyTermination: Stop search early when exact filename match is found (optional: defaults to true for file searches, false for content searches)

                        DECISION EXAMPLES:
                        - "find package.json" → searchType="files", pattern="package.json" (specific file)
                        - "find authentication components" → searchType="content", pattern="authentication" (looking for functionality)
                        - "locate all React components" → searchType="files", pattern="*.tsx" or "*.jsx" (file pattern)
                        - "find TODO comments" → searchType="content", pattern="TODO" (text in files)
                        - "show me login files" → AMBIGUOUS → run both: files with "login" AND content with "login"
                        - "find config" → AMBIGUOUS → run both: config files AND files containing config code

                        COMPREHENSIVE SEARCH EXAMPLES:
                        - Find package.json files: searchType="files", pattern="package.json"
                        - Find all JS files: searchType="files", pattern="*.js"
                        - Search for TODO in code: searchType="content", pattern="TODO", filePattern="*.js|*.ts"
                        - Search for exact code: searchType="content", pattern="toast.error('test')", literalSearch=true
                        - Ambiguous request "find auth stuff": Run two searches:
                          1. searchType="files", pattern="auth"
                          2. searchType="content", pattern="authentication"

                        Ambiguous requests can combine file-name and content searches for broader coverage.

                        This tool starts a background search process and returns immediately with a session ID owned by this Server instance.
                        Results are available through get_more_search_results on this Server instance, and stop_search can end the search early.

                        Perfect for large directories where you want to see results immediately and
                        have the option to cancel if the search takes too long or you find what you need.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(StartSearchArgsSchema),
                annotations: {
                    title: "Start Search",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "get_more_search_results",
                description: `
                        Get more results from an active search with offset-based pagination.

                        Supports partial result reading with:
                        - 'offset' (start result index, default: 0)
                          * Positive: Start from result N (0-based indexing)
                          * Negative: Read last N results from end (tail behavior)
                        - 'length' (max results to read, default: 100)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail results)

                        Examples:
                        - offset: 0, length: 100     → First 100 results
                        - offset: 200, length: 50    → Results 200-249
                        - offset: -20                → Last 20 results
                        - offset: -5, length: 10     → Last 5 results (length ignored)

                        Returns only results in the specified range, along with search status.
                        Works like read_process_output - call this repeatedly to get progressive
                        results from a search started with start_search on this Server instance.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(GetMoreSearchResultsArgsSchema),
                annotations: {
                    title: "Get Search Results",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "stop_search",
                description: `
                        Stop an active search owned by this Server instance.

                        Stops the background search process gracefully. Use this when you've found
                        what you need or if a search is taking too long. Similar to force_terminate
                        for terminal processes.

                        The search will still be available for reading final results until it's
                        automatically cleaned up after 5 minutes.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(StopSearchArgsSchema),
                annotations: {
                    title: "Stop Search",
                    readOnlyHint: false,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "list_searches",
                description: `
                        List all active searches owned by this Server instance.

                        Shows search IDs, search types, patterns, status, and runtime.
                        Similar to list_sessions for terminal processes. Useful for managing
                        multiple concurrent searches.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ListSearchesArgsSchema),
                annotations: {
                    title: "List Active Searches",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "get_file_info",
                description: `
                        Retrieve detailed metadata about a file or directory including:
                        - size
                        - creation time
                        - last modified time
                        - permissions
                        - type
                        - lineCount (for text files)
                        - lastLine (zero-indexed number of last line, for text files)
                        - appendPosition (line number for appending, for text files)
                        - sheets (for Excel files - array of {name, rowCount, colCount})

                        Only works within allowed directories.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(GetFileInfoArgsSchema),
                annotations: {
                    title: "Get File Information",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            // Note: list_allowed_directories removed - use get_config to check allowedDirectories

            // Editing tools
            {
                name: "edit_block",
                description: `
                        Apply surgical edits to files.

                        Small, focused edits are easier to verify than large multi-purpose replacements.
                        old_string can include enough surrounding context to uniquely identify the intended text.

                        FORMAT HANDLING (by extension):

                        EXCEL FILES (.xlsx, .xls, .xlsm) - Range Update mode:
                        Takes:
                        - file_path: Path to the Excel file
                        - range uses FROM:TO format - "SheetName!A1:C10" or "SheetName!C1:C1"
                        - content: 2D array, e.g., [["H1","H2"],["R1","R2"]]

                        TEXT FILES - Find/Replace mode:
                        Takes:
                        - file_path: Path to the file to edit
                        - old_string: Text to replace
                        - new_string: Replacement text
                        - expected_replacements: Optional number of replacements (default: 1)

                        DOCX FILES (.docx) - XML Find/Replace mode:
                        Takes same parameters as text files (old_string, new_string, expected_replacements).
                        Operates on the pretty-printed XML inside the DOCX — the same XML you see from
                        read_file with offset/length. Copy XML fragments from read output as old_string.
                        After editing, the XML is repacked into a valid DOCX.
                        Also searches headers/footers if not found in document body.
                        Examples:
                        - Replace text: old_string="<w:t>Old Text</w:t>" new_string="<w:t>New Text</w:t>"
                        - Change style: old_string='<w:pStyle w:val="Normal"/>' new_string='<w:pStyle w:val="Heading1"/>'
                        - Add content: include surrounding XML context in old_string, add new elements in new_string

                        By default, replaces only ONE occurrence of the search text.
                        To replace multiple occurrences, provide expected_replacements with
                        the exact number of matches expected.

                        UNIQUENESS REQUIREMENT: When expected_replacements=1 (default), include the minimal
                        amount of context necessary (typically 1-3 lines) before and after the change point,
                        with exact whitespace and indentation.

                        When editing multiple sections, make separate edit_block calls for each distinct change
                        rather than one large replacement.

                        When a close but non-exact match is found, a character-level diff is shown in the format:
                        common_prefix{-removed-}{+added+}common_suffix to help you identify what's different.

                        Similar to write_file, there is a configurable line limit (fileWriteLineLimit) that warns
                        if the edited file exceeds this limit. If this happens, consider breaking your edits into
                        smaller, more focused changes.

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(EditBlockArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Edit Block",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },

            // Terminal tools
            {
                name: "start_process",
                description: `
                        Start a terminal process on the authorized device with intelligent state detection.

                        Suitable for shell commands, interactive REPL sessions, data-processing scripts,
                        programmatic file analysis, and other long-running terminal work.

                        ${OS_GUIDANCE}

                        Examples:
                        • start_process("python3 -i") → Start an interactive Python REPL
                        • start_process("node -i") → Start an interactive Node.js REPL
                        • start_process("node:local") → Run stateless Node.js code on the MCP server
                        • start_process("wc -l /path/file.csv") → Run a one-shot shell command

                        Interactive process sessions support follow-up input after they are started.
                        Long-running process sessions expose newly available output while they remain active.
                        Ending the initial wait, including after timeout_ms, does not terminate a process that is still running.
                        Process-session tracking belongs to the current Desktop Commander server instance and is kept in memory.
                        If that server exits or restarts, the managed-session handle is lost even if an OS child process survives;
                        the MCP host or service manager may also terminate the child process tree. Jobs that must outlive Desktop
                        Commander should be launched under a separately owned OS-level service or supervisor.
                        Binary files can be processed with appropriate command-line tools or libraries available
                        in the selected process environment.

                        SMART DETECTION:
                        - Detects REPL prompts (>>>, >, $, etc.)
                        - Identifies when a process is waiting for input
                        - Recognizes process completion vs timeout
                        - Early exit prevents unnecessary waiting

                        STATES DETECTED:
                        Process waiting for input (shows prompt)
                        Process finished execution
                        Process running (use read_process_output)

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_exit, timeout)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(StartProcessArgsSchema),
                annotations: {
                    title: "Start Terminal Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: true,
                },
            },
            {
                name: "read_process_output",
                description: `
                        Read output from a running process with file-like pagination support.

                        Supports partial output reading with offset and length parameters (like read_file):
                        - 'offset' (start line, default: 0)
                          * offset=0: Read NEW output since last read (default, like old behavior)
                          * Positive: Read from absolute line position
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting)

                        Examples:
                        - offset: 0, length: 100     → First 100 NEW lines since last read
                        - offset: 0                  → All new lines (respects config limit)
                        - offset: 500, length: 50    → Lines 500-549 (absolute position)
                        - offset: -20                → Last 20 lines (tail)
                        - offset: -50, length: 10    → Start 50 from end, read 10 lines

                        OUTPUT PROTECTION:
                        - Uses same fileReadLineLimit as read_file (default: 1000 lines)
                        - Returns status like: [Reading 100 lines from line 0 (total: 5000 lines, 4900 remaining)]
                        - Prevents context overflow from verbose processes

                        SMART FEATURES:
                        - For offset=0, waits up to timeout_ms for new output to arrive
                        - Detects REPL prompts and process completion
                        - Shows process state (waiting for input, finished, etc.)

                        DETECTION STATES:
                        Process waiting for input (ready for interact_with_process)
                        Process finished execution
                        Timeout reached (may still be running)

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ReadProcessOutputArgsSchema),
                annotations: {
                    title: "Read Process Output",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "interact_with_process",
                description: `
                        Send input to an existing terminal or REPL process and return newly available output.

                        Useful for interactive shells, Python/Node/R/Julia REPLs, database consoles,
                        and long-running commands started with start_process().

                        Examples:
                        - Interactive Python REPL sessions can be started with \`python3 -i\`.
                        - Existing interactive sessions accept additional input such as imports or analysis commands.
                        - Interactive sessions can return newly available output while they remain active.
\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
                        SMART DETECTION:
                        - Automatically waits for a recognized prompt when requested
                        - Detects errors and completion states
                        - Early exit prevents unnecessary waiting
                        - Cleans common REPL prompt text from returned output
\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
                        PARAMETERS:
                        - pid: Process ID returned by start_process
                        - input: Text or command to send to the process
                        - timeout_ms: Maximum wait time (default: 8000ms)
                        - wait_for_prompt: Whether to wait for a prompt before returning (default: true)
                        - verbose_timing: Include detailed timing telemetry (default: false)

                        Returns execution result with status indicators.

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        When enabled, detailed timing includes:
                        - Exit reason
                        - Total duration and time to first output
                        - Timeline of output events

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(InteractWithProcessArgsSchema),
                annotations: {
                    title: "Send Input to Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: true,
                },
            },
            {
                name: "force_terminate",
                description: `
                        Force terminate a running terminal session.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ForceTerminateArgsSchema),
                annotations: {
                    title: "Force Terminate Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "list_sessions",
                description: `
                        List all active terminal sessions.

                        Shows session status including:
                        - PID: Process identifier
                        - Blocked: Whether session is waiting for input
                        - Runtime: How long the session has been running

                        DEBUGGING REPLs:
                        - "Blocked: true" often means REPL is waiting for input
                        - Use this to verify sessions are running before sending input
                        - Long runtime with blocked status may indicate stuck process

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ListSessionsArgsSchema),
                annotations: {
                    title: "List Terminal Sessions",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "list_processes",
                description: `
                        List all running processes.

                        Returns process information including PID, command name, CPU usage, and memory usage.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(ListProcessesArgsSchema),
                annotations: {
                    title: "List Running Processes",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "kill_process",
                description: `
                        Terminate a running process by PID.

                        For a PID that start_process returned, it ends the whole command: the shell and every process the command started, as force_terminate does. Any other PID ends that process only. Sessions started with node:local have a negative PID; stop them with force_terminate.

                        Use with caution as this will forcefully terminate the specified process.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(KillProcessArgsSchema),
                annotations: {
                    title: "Kill Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "get_usage_stats",
                description: `
                        Get usage statistics for debugging and analysis.

                        Returns summary of tool usage, success/failure rates, and performance metrics.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(GetUsageStatsArgsSchema),
                annotations: {
                    title: "Get Usage Statistics",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "get_recent_tool_calls",
                description: `
                        Get recent local tool call history with arguments and outputs.
                        Returns a chronological list of recent calls loaded from the local history file.

                        Useful for:
                        - Onboarding new chats about work already done
                        - Recovering context after chat history loss
                        - Debugging tool call sequences

                        Note: Does not track its own calls or track_ui_event.
                        History is persisted locally in tool-history.jsonl, keeps up to the last 1000
                        calls in memory, and trims older on-disk history. Stored outputs over 4 KiB
                        are replaced with an omission marker.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(GetRecentToolCallsArgsSchema),
                annotations: {
                    title: "Get Recent Tool Calls",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "give_feedback_to_desktop_commander",
                description: `
                        Open feedback form in browser to provide feedback about Desktop Commander.

                        The form itself collects survey answers; this tool does not accept survey responses or
                        pre-fill them. It automatically includes basic usage metadata:
                        - tool_call_count: Number of commands made
                        - days_using: Number of days Desktop Commander has been used
                        - platform: Operating system (Mac/Windows/Linux)
                        - client_id: Analytics identifier

                        No input parameters are required.

                        ${CMD_PREFIX_DESCRIPTION}`,
                inputSchema: toToolInputSchema(GiveFeedbackArgsSchema),
                annotations: {
                    title: "Give Feedback",
                    readOnlyHint: false,
                    openWorldHint: true,
                    destructiveHint: false,
                },
            },
        ];

        // Filter tools based on current client
        const filteredTools = allTools.filter(tool => shouldIncludeTool(tool.name, targetServer));

        // logToStderr('debug', `Returning ${filteredTools.length} tools (filtered from ${allTools.length} total) for client: ${currentClient?.name || 'unknown'}`);

        return {
            tools: filteredTools,
        };
    } catch (error) {
        logToStderr('error', `Error in list_tools request handler: ${error}`);
        throw error;
    }
});

targetServer.setRequestHandler('tools/call', async (request, ctx) => {
    updateCurrentClientFromEnvelope(targetServer, ctx.mcpReq.envelope);
    const requestMetadata = request.params._meta && typeof request.params._meta === 'object'
        ? request.params._meta as Record<string, any>
        : {};
    const isRemoteCall = !!requestMetadata.remote;
    const remoteClient = isRemoteCall
        ? (requestMetadata.clientInfo && (requestMetadata.clientInfo.name || requestMetadata.clientInfo.version)
            ? requestMetadata.clientInfo
            : { name: 'remote-unknown', version: 'unknown' })
        : null;
    // Snapshot attribution before any await; AsyncLocalStorage carries it through
    // nested async tool handlers and telemetry preparation without cross-call leaks.
    return runWithTelemetryRequestContext({
        client: { ...getServerRuntimeState(targetServer).clientInfo },
        remote: isRemoteCall,
        remoteClient,
    }, async () => {
    if (SDK_V2_CHATGPT_CAPABILITY_LAB_ENABLED) {
        const requestMeta = request.params._meta && typeof request.params._meta === 'object'
            ? request.params._meta as Record<string, unknown>
            : {};
        const hasProgressToken = Object.prototype.hasOwnProperty.call(requestMeta, 'progressToken');
        const diagnostics = getServerRuntimeState(targetServer).diagnostics;
        diagnostics.lastToolRequestName = request.params.name;
        diagnostics.lastToolRequestMetaKeys = Object.keys(requestMeta).sort();
        diagnostics.lastToolRequestProgressTokenPresent = hasProgressToken;
        diagnostics.lastToolRequestProgressTokenType = hasProgressToken
            ? typeof requestMeta.progressToken
            : null;
    }
    if (SDK_V2_EXPERIMENTAL_MRTR_ENABLED && request.params.name === SDK_V2_MRTR_TOOL_NAME && sdkV2MrtrStateCodec) {
        const confirmationSchema = z.object({ action: z.enum(['accept', 'decline']) });
        const responseView = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
        const state = ctx.mcpReq.requestState<{ proposalId: string; round: number }>();

        if (responseView.kind === 'elicit' && responseView.action !== 'accept') {
            return {
                content: [{ type: 'text', text: `SDK v2 multi-round-trip demo ${responseView.action}. No changes were made.` }],
                structuredContent: { status: responseView.action, proposalId: state?.proposalId ?? null },
            };
        }

        const response = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', confirmationSchema);
        if (response) {
            return {
                content: [{ type: 'text', text: `SDK v2 multi-round-trip demo complete: ${response.action}. No changes were made.` }],
                structuredContent: { status: response.action, proposalId: state?.proposalId ?? null },
            };
        }

        if (responseView.kind === 'elicit' && responseView.action === 'accept') {
            return {
                content: [{ type: 'text', text: 'Invalid confirmation response. No changes were made.' }],
                isError: true,
            };
        }

        const requestState = await sdkV2MrtrStateCodec.mint({ proposalId: 'sdk-v2-mrtr-demo', round: 1 }, ctx);
        return inputRequired({
            inputRequests: {
                confirm: inputRequired.elicit({
                    message: 'SDK v2 multi-round-trip demo: approve this side-effect-free proposal?',
                    requestedSchema: confirmationSchema,
                }),
            },
            requestState,
        });
    }

    const result = await handleToolsCallRequest(request, ctx.mcpReq.signal, targetServer);
    return targetServer.projectCallToolResult(result, undefined);
    });
});

targetServer.setRequestHandler('resources/templates/list', async (_request, ctx) => {
    updateCurrentClientFromEnvelope(targetServer, ctx.mcpReq.envelope);
    return { resourceTemplates: [] };
});
}

/**
 * Build a fresh, fully configured protocol Server for one stdio era attempt.
 * The exported binding remains compatible with legacy module consumers, while
 * registered handlers capture this instance so notifications and result
 * projection cannot be routed through a later era's Server.
 */
export function createServerInstance(): Server {
    server = new Server(
    {
        name: "desktop-commander",
        version: VERSION,
    },
    {
        capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true, subscribe: true },
            prompts: {},    // Add empty prompts capability
            logging: {},    // Add logging capability for console redirection
        },
        cacheHints: {
            // These catalogs are stable within a process and explicitly invalidated
            // by the list-changed notifications emitted by the UI/MRTR handlers below.
            'tools/list': { ttlMs: 30_000, cacheScope: 'private' },
            'resources/list': { ttlMs: 30_000, cacheScope: 'private' },
            'server/discover': { ttlMs: 30_000, cacheScope: 'private' },
        },
        instructions: SERVER_INSTRUCTIONS,
        ...(SDK_V2_EXPERIMENTAL_MRTR_ENABLED && sdkV2MrtrStateCodec ? {
            supportedProtocolVersions: ['2026-07-28', ...SUPPORTED_PROTOCOL_VERSIONS],
            requestState: { verify: sdkV2MrtrStateCodec.verify },
        } : {}),
    },
);
    currentClient = { name: 'uninitialized', version: 'uninitialized' };
    currentClientCapabilities = null;
    const createdServer = server;
    let shutdownPromise: Promise<void> | null = null;
    const disposeRuntimeState = (): Promise<void> => {
        if (shutdownPromise) return shutdownPromise;
        const runtimeState = serverRuntimeStates.get(createdServer);
        // Server lifecycle owns internal search workers, not user-launched processes.
        // Do not call process-tool/TerminalManager disposal here: doing so kills
        // commands started by the user when an MCP transport disconnects.
        // See docs/architecture/server-close-process-lifecycle.md; the rejected
        // auto-termination variant is archived under docs/alternative-specs/.
        const pendingShutdown = Promise.all([
            runtimeState?.searchManager?.dispose(),
        ]).then(() => undefined);
        shutdownPromise = pendingShutdown;
        // Let a later public close() retry cleanup after a transient failure.
        void pendingShutdown.catch(() => {
            if (shutdownPromise === pendingShutdown) shutdownPromise = null;
        });
        return pendingShutdown;
    };
    const reportShutdownError = (error: unknown) => {
        logToStderr('error', `Failed to dispose resources for closed Server: ${error instanceof Error ? error.message : String(error)}`);
    };

    // SDK 2.4.0 invokes Protocol.onclose synchronously and does not await a
    // Promise returned by the callback. Keep the hook for transport-initiated
    // closes, and wrap the public close() so callers can await owned resources.
    createdServer.onclose = () => {
        void disposeRuntimeState().catch(reportShutdownError);
    };
    const sdkClose = createdServer.close.bind(createdServer);
    createdServer.close = async () => {
        try {
            await sdkClose();
        } finally {
            await disposeRuntimeState();
        }
    };

    getServerRuntimeState(createdServer);
    registerServerHandlers(createdServer);
    return createdServer;
}

// Preserve the existing module-level server for tests and non-factory callers.
createServerInstance();
