import { deserializeMessage } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import process from "node:process";

export type LogLevel = "emergency" | "alert" | "critical" | "error" | "warning" | "notice" | "info" | "debug";
type LogSender = (level: LogLevel, data: unknown) => Promise<void>;

/**
 * Enhanced StdioServerTransport that wraps console output in valid JSON-RPC structures
 * instead of filtering them out. This prevents crashes while maintaining debug visibility.
 */
export class FilteredStdioServerTransport extends StdioServerTransport {
  private originalConsole: {
    log: typeof console.log;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
    info: typeof console.info;
  };
  private originalStdoutWrite: typeof process.stdout.write;
  private outputHooksRestored = false;
  private isInitialized: boolean = false;
  private messageBuffer: Array<{
    level: LogLevel;
    args: any[];
    timestamp: number;
  }> = [];
  private clientName: string = 'unknown';
  private disableNotifications: boolean = false;
  private logSender: LogSender | undefined;
  private logSendQueue: Promise<void> = Promise.resolve();
  // Keep SDK transport writes ordered; concurrent writes under stdout backpressure
  // can otherwise accumulate one `drain` listener per message for long sessions.
  private sendQueue: Promise<void> = Promise.resolve();

  constructor() {
    super();
    
    // Store original methods
    this.originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
      info: console.info,
    };
    
    this.originalStdoutWrite = process.stdout.write;
    
    // Setup console redirection
    this.setupConsoleRedirection();
    
    // Setup stdout filtering for any other output
    this.setupStdoutFiltering();
    
    // Note: We defer the initialization notification until enableNotifications() is called
    // to ensure MCP protocol compliance - notifications must not be sent before initialization
  }

  override start(): Promise<void> {
    // ChatGPT's transitional 2025 client sends server/discover before initialize
    // with a 2025 protocol-version claim. SDK v2 classifies every claimed
    // non-2026 revision as unsupported before the legacy server can answer the
    // probe with the expected -32601. Normalize only this one pre-init probe to
    // a claim-less legacy opening; preserve every other envelope unchanged.
    const dispatch = this.onmessage;
    if (dispatch) {
      this.onmessage = (message) => {
        const candidate = message as {
          method?: unknown;
          id?: unknown;
          params?: unknown;
        };
        if (
          candidate.method === 'server/discover' &&
          Object.prototype.hasOwnProperty.call(candidate, 'id') &&
          candidate.params !== null &&
          typeof candidate.params === 'object' &&
          !Array.isArray(candidate.params)
        ) {
          const params = candidate.params as Record<string, unknown>;
          const meta = params._meta;
          if (
            meta !== null &&
            typeof meta === 'object' &&
            !Array.isArray(meta) &&
            (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] === '2025-11-25'
          ) {
            const legacyMeta = { ...(meta as Record<string, unknown>) };
            delete legacyMeta['io.modelcontextprotocol/protocolVersion'];
            dispatch({
              ...message,
              params: { ...params, _meta: legacyMeta },
            } as typeof message);
            return;
          }
        }
        dispatch(message);
      };
    }
    return super.start();
  }

  override send(message: Parameters<StdioServerTransport['send']>[0]): Promise<void> {
    const pending = this.sendQueue.then(() => super.send(message));
    // A failed write rejects its caller but must not poison subsequent sends.
    this.sendQueue = pending.catch(() => {});
    return pending;
  }

  /**
   * Route MCP log notifications through the SDK server rather than writing JSON-RPC directly.
   */
  public setLogSender(sender: LogSender) {
    this.logSender = sender;
  }

  private dispatchLog(level: LogLevel, data: unknown) {
    if (!this.logSender) {
      const rendered = typeof data === 'string' ? data : JSON.stringify(data);
      process.stderr.write(`[${level.toUpperCase()}] ${rendered}\n`);
      return;
    }

    const sender = this.logSender;
    this.logSendQueue = this.logSendQueue
      .then(() => sender(level, data))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[ERROR] Failed to send MCP log notification: ${message}\n`);
      });
  }
  /**
   * Call this method after MCP initialization is complete to enable JSON-RPC notifications
   */
  public enableNotifications() {
    this.isInitialized = true;
    
    // Check if notifications should be disabled based on client
    if (this.disableNotifications) {
      // Clear buffer without sending - just log to stderr instead
      if (this.messageBuffer.length > 0) {
        process.stderr.write(`[INFO] ${this.messageBuffer.length} buffered messages suppressed for ${this.clientName}\n`);
      }
      this.messageBuffer = [];
      return;
    }
    
    // Send the deferred initialization notification first
    this.sendLogNotification('info', ['Enhanced FilteredStdioServerTransport initialized']);
    
    // Replay all buffered messages in chronological order
    if (this.messageBuffer.length > 0) {
      this.sendLogNotification('info', [`Replaying ${this.messageBuffer.length} buffered initialization messages`]);
      
      this.messageBuffer
        .sort((a, b) => a.timestamp - b.timestamp)
        .forEach(msg => {
          this.sendLogNotification(msg.level, msg.args);
        });
      
      // Clear the buffer
      this.messageBuffer = [];
    }
    
    this.sendLogNotification('info', ['JSON-RPC notifications enabled']);
  }

  /**
   * Configure client-specific behavior
   * Call this BEFORE enableNotifications()
   */
  public configureForClient(clientName: string) {
    this.clientName = clientName.toLowerCase();
    
    // Detect Cline and disable notifications
    if (this.clientName.includes('cline') || 
        this.clientName.includes('vscode') ||
        this.clientName === 'claude-dev') {
      this.disableNotifications = true;
      process.stderr.write(`[INFO] Desktop Commander: Notifications disabled for ${clientName}\n`);
    }
  }

  /**
   * Check if notifications are enabled
   */
  public get isNotificationsEnabled(): boolean {
    return this.isInitialized;
  }

  /**
   * Get the current count of buffered messages
   */
  public get bufferedMessageCount(): number {
    return this.messageBuffer.length;
  }

  private setupConsoleRedirection() {
    console.log = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("info", args);
      } else {
        // Buffer for later replay to client
        this.messageBuffer.push({
          level: "info",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.info = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("info", args);
      } else {
        this.messageBuffer.push({
          level: "info",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.warn = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("warning", args);
      } else {
        this.messageBuffer.push({
          level: "warning",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.error = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("error", args);
      } else {
        this.messageBuffer.push({
          level: "error",
          args,
          timestamp: Date.now()
        });
      }
    };

    console.debug = (...args: any[]) => {
      if (this.isInitialized) {
        this.sendLogNotification("debug", args);
      } else {
        this.messageBuffer.push({
          level: "debug",
          args,
          timestamp: Date.now()
        });
      }
    };
  }

  private setupStdoutFiltering() {
    process.stdout.write = (buffer: any, encoding?: any, callback?: any): boolean => {
      const bufferEncoding = typeof encoding === 'string' && Buffer.isEncoding(encoding)
        ? encoding
        : undefined;
      const text = typeof buffer === 'string'
        ? buffer
        : Buffer.isBuffer(buffer)
          ? buffer.toString(bufferEncoding)
          : undefined;

      if (text !== undefined) {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
          return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
        }

        // Only exact SDK-parseable JSON-RPC frames may use stdout. JSON-looking
        // application output is still logging and must not corrupt the MCP stream.
        try {
          deserializeMessage(trimmed);
          return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
        } catch {
          const message = text.replace(/\n$/, '');
          if (this.isInitialized) {
            this.sendLogNotification("info", [message]);
          } else {
            this.messageBuffer.push({
              level: "info",
              args: [message],
              timestamp: Date.now()
            });
          }

          const writeCallback = typeof encoding === 'function' ? encoding : callback;
          if (writeCallback) writeCallback();
          return true;
        }
      }

      // Unknown stdout chunk types are not expected from the SDK; preserve Node's
      // native behavior rather than guessing how to decode them.
      return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
    };
  }

  private sendLogNotification(level: LogLevel, args: any[]) {
    // Skip if notifications are disabled (e.g., for Cline)
    if (this.disableNotifications) {
      return;
    }

    try {
      let data: unknown;
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
        data = args[0];
      } else {
        data = args.map(arg => {
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg, null, 2);
            } catch {
              return String(arg);
            }
          }
          return String(arg);
        }).join(' ');
      }

      this.dispatchLog(level, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[ERROR] Log serialization failed: ${message}\n`);
    }
  }
  /**
   * Public method to send log notifications from anywhere in the application.
   * Messages are buffered until MCP initialization completes.
   */
  public sendLog(level: LogLevel, message: string, data?: any) {
    if (this.disableNotifications) {
      return;
    }

    const payload = data ? { message, ...data } : message;
    if (!this.isInitialized) {
      this.messageBuffer.push({
        level,
        args: [payload],
        timestamp: Date.now()
      });
      return;
    }

    this.dispatchLog(level, payload);
  }
  /**
   * Restore the process-wide output hooks. Safe to call more than once.
   */
  public cleanup() {
    if (this.outputHooksRestored) return;
    this.outputHooksRestored = true;

    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    console.debug = this.originalConsole.debug;
    console.info = this.originalConsole.info;
    process.stdout.write = this.originalStdoutWrite;
  }

  /**
   * Close the wire first so Protocol.onclose can run, then release the
   * callbacks that otherwise keep the connected Server / serveStdio state
   * reachable through this process-global transport.
   */
  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      this.cleanup();
      this.messageBuffer = [];
      this.logSender = undefined;
      this.logSendQueue = Promise.resolve();
      this.sendQueue = Promise.resolve();
      this.onmessage = undefined;
      this.onerror = undefined;
      this.onclose = undefined;
    }
  }
}
