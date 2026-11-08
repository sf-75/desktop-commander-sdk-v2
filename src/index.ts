#!/usr/bin/env node

// MUST be first: raises the libuv threadpool size before any fs work is
// submitted. See src/bootstrap.ts for why import order matters.
import './bootstrap.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FilteredStdioServerTransport } from './custom-stdio.js';
import { SDK_V2_EXPERIMENTAL_MRTR_ENABLED, createServerInstance, flushDeferredMessages, handleInitializedClient } from './server.js';
import { commandManager } from './command-manager.js';
import { configManager } from './config-manager.js';
import { featureFlagManager } from './utils/feature-flags.js';
import { runSetup } from './npm-scripts/setup.js';
import { runUninstall } from './npm-scripts/uninstall.js';
import { capture } from './utils/capture.js';
import { logToStderr, logger } from './utils/logger.js';
import { exitProcess } from './utils/exit-process.js';
import { runRemote } from './npm-scripts/remote.js';
import { ensureChromeAvailable } from './tools/pdf/markdown.js';
import { preloadFileSupport } from './utils/files/index.js';

// Store messages to defer until after initialization
const deferredMessages: Array<{ level: string, message: string }> = [];
const SDK_V2_FORCE_LEGACY_STDIO =
  process.env.DC_SDK_V2_PLAYGROUND === '1' &&
  process.env.DC_SDK_V2_FORCE_LEGACY_STDIO === '1';
function deferLog(level: string, message: string) {
  deferredMessages.push({ level, message });
}

async function runServer() {
  try {
    // Check if first argument is "setup"
    if (process.argv[2] === 'setup') {
      await runSetup();
      return;
    }

    // Check if first argument is "remove"
    if (process.argv[2] === 'remove') {
      await runUninstall();
      return;
    }

    // Check if first argument is "remote"
    if (process.argv[2] === 'remote') {
      await runRemote();
      return;
    }

    // Parse command line arguments for onboarding control
    const DISABLE_ONBOARDING = process.argv.includes('--no-onboarding');
    if (DISABLE_ONBOARDING) {
      logToStderr('info', 'Onboarding disabled via --no-onboarding flag');
    }

    // Set global flag for onboarding control
    global.disableOnboarding = DISABLE_ONBOARDING;

    // Create transport FIRST so all logging gets properly buffered
    // This must happen before any code that might use logger.*
    const transport = new FilteredStdioServerTransport();

    // Export transport for use throughout the application
    global.mcpTransport = transport;

    try {
      deferLog('info', 'Loading configuration...');
      await configManager.loadConfig();
      deferLog('info', 'Configuration loaded successfully');

      // Initialize feature flags (non-blocking)
      deferLog('info', 'Initializing feature flags...');
      await featureFlagManager.initialize();
    } catch (configError) {
      deferLog('error', `Failed to load configuration: ${configError instanceof Error ? configError.message : String(configError)}`);
      if (configError instanceof Error && configError.stack) {
        deferLog('debug', `Stack trace: ${configError.stack}`);
      }
      deferLog('warning', 'Continuing with in-memory configuration only');
      // Continue anyway - we'll use an in-memory config
    }

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing error: ${errorMessage}`);
        return; // Don't exit on JSON parsing errors
      }

      capture('run_server_uncaught_exception', {
        error: errorMessage
      });

      logger.error(`Uncaught exception: ${errorMessage}`);
      exitProcess(1);
    });

    // Handle unhandled rejections: log and keep serving. The code that created
    // the promise has already moved on (often a library's detached cleanup, as
    // with puppeteer's profile removal), so the server's state is intact, and
    // exiting would drop every running process, session and search.
    process.on('unhandledRejection', async (reason) => {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);

      // A JSON parsing error is logged as before, and not sent to telemetry
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing rejection: ${errorMessage}`);
        return;
      }

      capture('run_server_unhandled_rejection', {
        error: errorMessage
      });

      logger.error(`Unhandled rejection: ${errorMessage}`);
    });

    capture('run_server_start');

    deferLog('info', 'Connecting server...');

    // EOF is not guaranteed to trigger Server.onclose for every SDK v2 stdio era.
    // Stop only the config watcher here; never dispose user-started processes.
    let configWatcherStopped = false;
    const stopConfigWatcherOnEof = () => {
      if (configWatcherStopped) return;
      configWatcherStopped = true;
      process.stdin.off('end', stopConfigWatcherOnEof);
      process.stdin.off('close', stopConfigWatcherOnEof);
      configManager.stopConfigWatcher();
    };
    process.stdin.once('end', stopConfigWatcherOnEof);
    process.stdin.once('close', stopConfigWatcherOnEof);

    // Every era attempt gets a fresh Server. serveStdio may discard the modern
    // discovery probe and call this factory again for the legacy fallback.
    const configureServerInstance = (instance: ReturnType<typeof createServerInstance>) => {
      transport.setLogSender((level, data) => instance.sendLoggingMessage({
        level,
        logger: 'desktop-commander',
        data,
      }));

      // The legacy SDK initialize handler invokes oninitialized after the
      // client sends notifications/initialized.
      instance.oninitialized = () => {
        handleInitializedClient(instance);
        transport.enableNotifications();

        while (deferredMessages.length > 0) {
          const msg = deferredMessages.shift()!;
          transport.sendLog('info', msg.message);
        }
        flushDeferredMessages();
        transport.sendLog('info', 'Server connected successfully');
        transport.sendLog('info', 'MCP fully initialized, all startup messages sent');
        ensureChromeAvailable();
        preloadFileSupport();
      };
      return instance;
    };

    if (SDK_V2_EXPERIMENTAL_MRTR_ENABLED && !SDK_V2_FORCE_LEGACY_STDIO) {
      // 2026-era stdio needs the era-aware entrypoint so server/discover can
      // select a modern protocol revision before a server instance is pinned.
      // ChatGPT currently sends a transitional 2025-11-25 server/discover
      // envelope; only the isolated Playground honors FORCE_LEGACY_STDIO so
      // the 2025 MRTR app fallback remains testable without changing other
      // SDK v2 runtimes that enable the experimental protocol surface.
      serveStdio(() => configureServerInstance(createServerInstance()), { transport });
    } else {
      await configureServerInstance(createServerInstance()).connect(transport);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`FATAL ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }
    logToStderr('error', `Failed to start server: ${errorMessage} (${new Date().toISOString()})`);

    capture('run_server_failed_start_error', {
      error: errorMessage
    });
    exitProcess(1);
  }
}

runServer().catch(async (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`RUNTIME ERROR: ${errorMessage}`);
  console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
  process.stderr.write(JSON.stringify({
    type: 'error',
    timestamp: new Date().toISOString(),
    message: `Fatal error running server: ${errorMessage}`
  }) + '\n');


  capture('run_server_fatal_error', {
    error: errorMessage
  });
  exitProcess(1);
});