/**
 * Centralized logging utility for Desktop Commander.
 * Protocol logging goes through the MCP transport; diagnostics that cannot
 * safely use the protocol go to stderr.
 */

import type { FilteredStdioServerTransport } from '../custom-stdio.js';

// Global reference to the MCP transport (set in index.ts)
declare global {
  var mcpTransport: FilteredStdioServerTransport | undefined;
}

export type LogLevel = 'emergency' | 'alert' | 'critical' | 'error' | 'warning' | 'notice' | 'info' | 'debug';

/**
 * Log a message using MCP logging when the transport exists. The transport
 * buffers messages until initialization completes and routes live messages
 * through the SDK logging notification funnel.
 */
export function log(level: LogLevel, message: string, data?: any): void {
  try {
    if (global.mcpTransport) {
      global.mcpTransport.sendLog(level, message, data);
      return;
    }

    // Compatibility fallback for direct module consumers that do not construct
    // Desktop Commander's transport (some tests and embedding use this path).
    // The normal server path always installs mcpTransport first and therefore
    // routes logging through server.sendLoggingMessage().
    const notification = {
      jsonrpc: '2.0' as const,
      method: 'notifications/message',
      params: {
        level,
        logger: 'desktop-commander',
        data: data ? { message, ...data } : message,
      },
    };
    process.stdout.write(`${JSON.stringify(notification)}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[ERROR] Failed to log message: ${message} (${reason})\n`);
  }
}

/** Convenience functions for different log levels. */
export const logger = {
  emergency: (message: string, data?: any) => log('emergency', message, data),
  alert: (message: string, data?: any) => log('alert', message, data),
  critical: (message: string, data?: any) => log('critical', message, data),
  error: (message: string, data?: any) => log('error', message, data),
  warning: (message: string, data?: any) => log('warning', message, data),
  notice: (message: string, data?: any) => log('notice', message, data),
  info: (message: string, data?: any) => log('info', message, data),
  debug: (message: string, data?: any) => log('debug', message, data),
};

/**
 * Emit a protocol-external diagnostic. Stdio servers reserve stdout for MCP;
 * stderr is the safe channel before initialization and when protocol logging
 * itself is unavailable.
 */
export function logToStderr(level: LogLevel, message: string): void {
  process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
}
