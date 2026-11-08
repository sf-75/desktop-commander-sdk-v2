import { 
    listProcesses,
    killProcess
} from '../tools/process.js';

import { 
    KillProcessArgsSchema
} from '../tools/schemas.js';

import { ServerResult } from '../types.js';
import type { ProcessToolContext } from '../tools/improved-process-tools.js';

/**
 * Handle list_processes command
 */
export async function handleListProcesses(): Promise<ServerResult> {
    return listProcesses();
}

/**
 * Handle kill_process command
 */
export async function handleKillProcess(args: unknown, context?: ProcessToolContext): Promise<ServerResult> {
    const parsed = KillProcessArgsSchema.parse(args);
    return context ? killProcess(parsed, context.terminalManager) : killProcess(parsed);
}
