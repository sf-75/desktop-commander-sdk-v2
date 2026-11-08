import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = new Server(
  { name: 'sdk-v2-progress-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'progress_probe',
    description: 'Emits ordered progress notifications when the requester supplies a progress token.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
}));

server.setRequestHandler('tools/call', async (request, ctx) => {
  if (request.params.name !== 'progress_probe') {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  const progressToken = ctx?.mcpReq?._meta?.progressToken;
  console.error(`PROGRESS_TOKEN_PRESENT=${progressToken !== undefined}`);
  console.error(`PROGRESS_TOKEN_TYPE=${typeof progressToken}`);

  if (progressToken !== undefined) {
    for (const [progress, message] of [[1, 'step 1'], [2, 'step 2'], [3, 'step 3']]) {
      await ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken, progress, total: 3, message },
      });
      // The client dispatches inbound notifications asynchronously. Real progress
      // updates are naturally spaced by work, so give each update its own turn.
      await sleep(10);
    }
  }

  return { content: [{ type: 'text', text: 'progress probe complete' }] };
});

await server.connect(new StdioServerTransport());
