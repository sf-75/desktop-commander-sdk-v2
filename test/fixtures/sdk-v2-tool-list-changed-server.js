import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

let expanded = false;
let listCalls = 0;

const server = new Server(
  { name: 'sdk-v2-tool-list-changed-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler('tools/list', async () => {
  listCalls += 1;
  console.error(`TOOLS_LIST_CALL=${listCalls}`);
  const tools = [{
    name: 'toggle_tools',
    description: 'Adds a second tool and sends tools/list_changed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }];
  if (expanded) {
    tools.push({
      name: 'dynamic_tool',
      description: 'Appears after a list-changed notification.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
  }
  return { tools };
});

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name !== 'toggle_tools') {
    return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
  }
  expanded = true;
  await server.sendToolListChanged();
  return { content: [{ type: 'text', text: 'tool list changed' }] };
});

await server.connect(new StdioServerTransport());
