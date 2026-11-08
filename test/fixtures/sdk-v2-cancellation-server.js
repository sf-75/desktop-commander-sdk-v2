import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = new Server(
  { name: 'sdk-v2-cancellation-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'slow_cancel_probe',
    description: 'Waits long enough for a client cancellation probe.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
}));

server.setRequestHandler('tools/call', async (request, ctx) => {
  if (request.params.name !== 'slow_cancel_probe') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const signal = ctx?.mcpReq?.signal;
  if (!signal) {
    console.error('CTX_SIGNAL_MISSING');
    return {
      content: [{ type: 'text', text: 'Request context did not expose mcpReq.signal.' }],
      isError: true,
    };
  }

  console.error(`CTX_SIGNAL_READY aborted=${signal.aborted}`);
  for (let step = 0; step < 500; step++) {
    if (signal.aborted) {
      console.error(`CTX_SIGNAL_ABORTED reason=${String(signal.reason)}`);
      return { content: [{ type: 'text', text: `cancel observed at step ${step}` }] };
    }
    await sleep(10);
  }

  console.error('CTX_SIGNAL_NOT_ABORTED');
  return { content: [{ type: 'text', text: 'completed without cancellation' }] };
});

await server.connect(new StdioServerTransport());
