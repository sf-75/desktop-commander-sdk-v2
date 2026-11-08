import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new Server(
  { name: 'sdk-v2-logging-fixture', version: '1.0.0' },
  { capabilities: { tools: {}, logging: {} } },
);

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'emit_logs',
    description: 'Emit four logging levels.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name !== 'emit_logs') {
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
  for (const level of ['debug', 'info', 'warning', 'error']) {
    await server.sendLoggingMessage({ level, logger: 'fixture', data: level });
  }
  return { content: [{ type: 'text', text: 'emitted' }] };
});

await server.connect(new StdioServerTransport());
