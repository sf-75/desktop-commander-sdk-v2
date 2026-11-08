import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const RESOURCE_URI = "test://dc-sdk-v2/subscription-resource";
const OTHER_RESOURCE_URI = "test://dc-sdk-v2/unsubscribed-resource";
let catalogVersion = 1;
let toolsListReads = 0;
let resourcesListReads = 0;
let resourceReadCount = 0;

const server = new Server(
  { name: "dc-sdk-v2-subscriptions-e2e", version: "1.0.0" },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
    },
    supportedProtocolVersions: ["2026-07-28"],
    cacheHints: {
      "tools/list": { ttlMs: 60_000, cacheScope: "private" },
      "resources/list": { ttlMs: 60_000, cacheScope: "private" },
      "resources/read": { ttlMs: 60_000, cacheScope: "private" },
    },
  },
);

server.setRequestHandler("tools/list", async () => {
  toolsListReads += 1;
  return {
    tools: [
      {
        name: "trigger_changes",
        description: "Trigger harmless dynamic catalog and resource notifications.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "stable_tool",
        description: "catalog-read-" + toolsListReads,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      ...(catalogVersion >= 2
        ? [{
            name: "dynamic_tool_v2",
            description: "A tool added after a list-changed event.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          }]
        : []),
    ],
  };
});

server.setRequestHandler("tools/call", async (request) => {
  const name = request.params?.name;
  if (name !== "trigger_changes") {
    return { content: [{ type: "text", text: "Unknown test tool." }], isError: true };
  }
  catalogVersion = 2;
  await server.sendToolListChanged();
  await server.sendResourceListChanged();
  await server.sendResourceUpdated({ uri: RESOURCE_URI });
  await server.sendResourceUpdated({ uri: OTHER_RESOURCE_URI });
  return { content: [{ type: "text", text: "Dynamic catalog and resource notifications sent." }] };
});

server.setRequestHandler("resources/list", async () => {
  resourcesListReads += 1;
  return {
    resources: [{
      uri: RESOURCE_URI,
      name: "resource-list-read-" + resourcesListReads,
      mimeType: "text/plain",
    }],
  };
});

server.setRequestHandler("resources/read", async (request) => {
  resourceReadCount += 1;
  return {
    contents: [{
      uri: request.params.uri,
      mimeType: "text/plain",
      text: "resource-version-" + catalogVersion + "-read-" + resourceReadCount,
    }],
  };
});

serveStdio(() => server, {
  onerror: (error) => process.stderr.write("[subscriptions-e2e-server] " + error.message + "\n"),
});