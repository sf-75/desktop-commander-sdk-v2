import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new Server(
  { name: 'sdk-v2-custom-initialize-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler('initialize', async (request) => ({
  protocolVersion: request.params.protocolVersion,
  capabilities: { tools: {} },
  serverInfo: { name: 'sdk-v2-custom-initialize-fixture', version: '1.0.0' },
}));

server.setRequestHandler('tools/list', async () => ({
  tools: [{ name: 'state', description: 'Return SDK state.', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler('tools/call', async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    version: server.getNegotiatedProtocolVersion() ?? null,
    clientVersion: server.getClientVersion() ?? null,
    clientCapabilities: server.getClientCapabilities() ?? null,
  }) }],
}));

await server.connect(new StdioServerTransport());
