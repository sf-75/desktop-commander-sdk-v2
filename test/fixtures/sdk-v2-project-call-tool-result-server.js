import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new Server(
  { name: 'sdk-v2-project-call-tool-result-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'object_probe',
      description: 'Returns object-shaped structuredContent.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'scalar_probe',
      description: 'Returns scalar structuredContent without text content.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
}));

server.setRequestHandler('tools/call', async (request) => {
  const version = server.getNegotiatedProtocolVersion();
  console.error(`NEGOTIATED_VERSION=${version ?? 'none'}`);

  let raw;
  if (request.params.name === 'object_probe') {
    raw = {
      content: [{ type: 'text', text: 'object probe' }],
      structuredContent: { answer: 42 },
    };
  } else if (request.params.name === 'scalar_probe') {
    raw = {
      content: [],
      structuredContent: 'scalar-value',
    };
  } else {
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }

  const projected = server.projectCallToolResult(raw, undefined);
  console.error(`PROJECTED_${request.params.name.toUpperCase()}=${JSON.stringify(projected)}`);
  return projected;
});

await server.connect(new StdioServerTransport());
