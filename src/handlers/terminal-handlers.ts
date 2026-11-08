import { 
    startProcess, 
    readProcessOutput, 
    interactWithProcess,
    forceTerminate, 
    listSessions 
} from '../tools/improved-process-tools.js';
import type { ProcessToolContext } from '../tools/improved-process-tools.js';

import { 
    StartProcessArgsSchema,
    ReadProcessOutputArgsSchema,
    InteractWithProcessArgsSchema,
    ForceTerminateArgsSchema,
    ListSessionsArgsSchema
} from '../tools/schemas.js';

import { ServerResult } from '../types.js';

/**
 * Handle start_process command (improved execute_command)
 */
export async function handleStartProcess(args: unknown, context?: ProcessToolContext): Promise<ServerResult> {
    const parsed = StartProcessArgsSchema.parse(args);
    return context ? startProcess(parsed, undefined, context) : startProcess(parsed);
}

/**
 * Handle read_process_output command (improved read_output)
 */
export async function handleReadProcessOutput(args: unknown, context?: ProcessToolContext): Promise<ServerResult> {
    const parsed = ReadProcessOutputArgsSchema.parse(args);
    return context ? readProcessOutput(parsed, undefined, context) : readProcessOutput(parsed);
}

/**
 * Handle interact_with_process command (improved send_input)
 */
export async function handleInteractWithProcess(args: unknown, context?: ProcessToolContext): Promise<ServerResult> {
    return context ? interactWithProcess(args, undefined, context) : interactWithProcess(args);
}

/**
 * Handle force_terminate command
 */
export async function handleForceTerminate(args: unknown, context?: ProcessToolContext): Promise<ServerResult> {
    const parsed = ForceTerminateArgsSchema.parse(args);
    return context ? forceTerminate(parsed, context) : forceTerminate(parsed);
}

/**
 * Handle list_sessions command
 */
export async function handleListSessions(context?: ProcessToolContext): Promise<ServerResult> {
    return context ? listSessions(context) : listSessions();
}