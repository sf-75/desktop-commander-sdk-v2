import assert from 'node:assert/strict';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { FilteredStdioServerTransport } from '../dist/custom-stdio.js';

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
  info: console.info,
};
const originalStdoutWrite = process.stdout.write;
const previousGlobalTransport = global.mcpTransport;
const transport = new FilteredStdioServerTransport();
let closeNotifications = 0;

try {
  global.mcpTransport = transport;
  transport.setLogSender(async () => {});
  let factoryCalls = 0;
  const handle = serveStdio(() => {
    factoryCalls++;
    throw new Error('the close-only fixture must not create a server instance');
  }, { transport });
  const originalOnClose = transport.onclose;
  transport.onclose = () => {
    closeNotifications++;
    originalOnClose?.();
  };
  transport.sendLog('info', 'buffered-until-initialize');

  assert.equal(typeof transport.onmessage, 'function', 'serveStdio must install its inbound pump');
  assert.equal(typeof transport.onerror, 'function', 'serveStdio must install its error callback');
  assert.equal(transport.bufferedMessageCount, 1);
  assert.notEqual(console.log, originalConsole.log);
  assert.notEqual(process.stdout.write, originalStdoutWrite);

  await transport.close();
  await handle.close();

  assert.equal(factoryCalls, 0, 'closing before negotiation must not construct a Server instance');
  assert.equal(closeNotifications, 1, 'the SDK close callback must run before transport callbacks are cleared');
  assert.equal(transport.onmessage, undefined, 'closed transport must release its message callback');
  assert.equal(transport.onerror, undefined, 'closed transport must release its error callback');
  assert.equal(transport.onclose, undefined, 'closed transport must release its close callback');
  assert.equal(transport.logSender, undefined, 'closed transport must release the Server-bound log sender');
  assert.equal(transport.bufferedMessageCount, 0, 'closed transport must release buffered startup logs');
  assert.equal(console.log, originalConsole.log, 'close must restore console.log');
  assert.equal(console.warn, originalConsole.warn, 'close must restore console.warn');
  assert.equal(console.error, originalConsole.error, 'close must restore console.error');
  assert.equal(console.debug, originalConsole.debug, 'close must restore console.debug');
  assert.equal(console.info, originalConsole.info, 'close must restore console.info');
  assert.equal(process.stdout.write, originalStdoutWrite, 'close must restore stdout.write');

  await transport.close();
  transport.cleanup();
  assert.equal(closeNotifications, 1, 'close and cleanup must be idempotent');

  const stdinBaseline = Object.fromEntries(['data', 'error', 'end', 'close'].map((event) => [event, process.stdin.listenerCount(event)]));
  const stdoutErrorBaseline = process.stdout.listenerCount('error');
  for (let i = 0; i < 25; i += 1) {
    const cycleTransport = new FilteredStdioServerTransport();
    const cycleHandle = serveStdio(() => {
      throw new Error('transport restart probe must not create a Server instance');
    }, { transport: cycleTransport });
    await cycleTransport.close();
    await cycleHandle.close();

    for (const [event, count] of Object.entries(stdinBaseline)) {
      assert.equal(process.stdin.listenerCount(event), count, `stdin ${event} listeners must return to baseline after cycle ${i}`);
    }
    assert.equal(process.stdout.listenerCount('error'), stdoutErrorBaseline, `stdout error listeners must remain bounded after cycle ${i}`);
    assert.equal(console.log, originalConsole.log, `console.log must be restored after cycle ${i}`);
    assert.equal(process.stdout.write, originalStdoutWrite, `stdout.write must be restored after cycle ${i}`);
  }

  console.log('PASS FilteredStdioServerTransport close releases callbacks/hooks and remains bounded across 25 serveStdio cycles');
} finally {
  await transport.close();
  global.mcpTransport = previousGlobalTransport;
}
