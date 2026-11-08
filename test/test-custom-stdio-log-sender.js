import assert from 'assert';
import { FilteredStdioServerTransport } from '../dist/custom-stdio.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function runTests() {
  const sent = [];
  const transport = new FilteredStdioServerTransport();
  try {
    transport.setLogSender(async (level, data) => {
      if (data === 'Enhanced FilteredStdioServerTransport initialized') {
        await sleep(30);
      }
      sent.push({ level, data });
    });

    transport.sendLog('info', 'before-init');
    assert.strictEqual(transport.bufferedMessageCount, 1);
    assert.strictEqual(sent.length, 0);

    transport.enableNotifications();
    await sleep(80);
    assert.deepStrictEqual(sent.slice(0, 4).map(entry => entry.data), [
      'Enhanced FilteredStdioServerTransport initialized',
      'Replaying 1 buffered initialization messages',
      'before-init',
      'JSON-RPC notifications enabled',
    ]);

    transport.sendLog('warning', 'after-init', { code: 7 });
    await sleep(20);
    assert.ok(sent.some(entry => entry.level === 'warning'
      && entry.data?.message === 'after-init'
      && entry.data?.code === 7));
  } finally {
    transport.cleanup();
  }

  const suppressed = [];
  const clineTransport = new FilteredStdioServerTransport();
  try {
    clineTransport.setLogSender(async (level, data) => { suppressed.push({ level, data }); });
    clineTransport.configureForClient('cline');
    clineTransport.sendLog('info', 'before-init-cline');
    clineTransport.enableNotifications();
    clineTransport.sendLog('warning', 'after-init-cline');
    await sleep(20);
    assert.strictEqual(clineTransport.bufferedMessageCount, 0);
    assert.deepStrictEqual(suppressed, []);
  } finally {
    clineTransport.cleanup();
  }

  console.log('✓ custom stdio preserves buffered log order and Cline suppression with injected sender');
  return true;
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});