import { Server, acceptedContent, createRequestStateCodec, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const stateCodec = createRequestStateCodec({
  key: 'desktop-commander-sdk-v2-mrtr-fixture-key-20261029',
  ttlSeconds: 60,
});

function createServer() {
  const server = new Server(
    { name: 'sdk-v2-mrtr-fixture', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      supportedProtocolVersions: ['2026-07-28', '2025-11-25'],
      requestState: { verify: stateCodec.verify },
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [{
      name: 'mrtr_probe',
      description: 'Side-effect-free multi-round-trip confirmation probe.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }],
  }));

  server.setRequestHandler('tools/call', async (request, ctx) => {
    if (request.params.name !== 'mrtr_probe') {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    }

    const state = ctx.mcpReq.requestState();
    const confirmationSchema = z.object({ action: z.enum(['accept', 'decline']) });
    const response = acceptedContent(
      ctx.mcpReq.inputResponses,
      'confirm',
      confirmationSchema,
    );

    if (!response) {
      const requestState = await stateCodec.mint({ proposalId: 'fixture-proposal-1', round: 1 }, ctx);
      console.error(`MRTR_INITIAL_STATE=${Boolean(requestState)}`);
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: 'この提案を承認しますか？',
            requestedSchema: confirmationSchema,
          }),
        },
        requestState,
      });
    }

    console.error(`MRTR_REENTRY_STATE=${JSON.stringify(state)}`);
    console.error(`MRTR_RESPONSE=${response.action}`);
    return {
      content: [{ type: 'text', text: `mrtr complete: ${response.action}` }],
      structuredContent: {
        status: response.action,
        proposalId: state?.proposalId ?? null,
      },
    };
  });

  return server;
}

serveStdio(() => createServer());
