import { Server } from '@modelcontextprotocol/server';
import { FilteredStdioServerTransport } from '../../dist/custom-stdio.js';

const server = new Server(
  { name: 'sdk-v2-custom-stdio-logging-fixture', version: '1.0.0' },
  { capabilities: { tools: {}, logging: {} } },
);

const transport = new FilteredStdioServerTransport();
transport.setLogSender((level, data) => server.sendLoggingMessage({
  level,
  logger: 'desktop-commander',
  data,
}));

server.oninitialized = () => {
  transport.enableNotifications();
};

server.setRequestHandler('tools/list', async () => ({
  tools: [
    { name: 'emit_stdout_noise', description: 'Emit JSON-looking and Buffer stdout noise.', inputSchema: { type: 'object', properties: {} } },
    { name: 'emit_logs', description: 'Emit debug and warning logs.', inputSchema: { type: 'object', properties: {} } },
  ],
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name === 'emit_stdout_noise') {
    process.stdout.write('{"id":"not-protocol","message":"json-like-log"}\n');
    process.stdout.write(Buffer.from('buffer-noise\n'));
    return { content: [{ type: 'text', text: 'noise-ok' }] };
  }

  transport.sendLog('debug', 'debug-message');
  transport.sendLog('warning', 'warning-message');
  return { content: [{ type: 'text', text: 'ok' }] };
});

await server.connect(transport);