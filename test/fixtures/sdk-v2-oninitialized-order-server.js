import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let synchronousInitializedWorkDone = false;
let asynchronousInitializedWorkDone = false;
const server = new Server(
  { name: 'sdk-v2-oninitialized-order-fixture', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: 'fixture instructions' },
);
server.oninitialized = async () => {
  synchronousInitializedWorkDone = true;
  await sleep(100);
  asynchronousInitializedWorkDone = true;
};
server.setRequestHandler('tools/list', async () => ({
  tools: [{ name: 'state', description: 'Return state.', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler('tools/call', async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    synchronousInitializedWorkDone,
    asynchronousInitializedWorkDone,
    version: server.getNegotiatedProtocolVersion() ?? null,
    clientName: server.getClientVersion()?.name ?? null,
    clientCapabilitiesPresent: server.getClientCapabilities() !== undefined,
  }) }],
}));
await server.connect(new StdioServerTransport());
