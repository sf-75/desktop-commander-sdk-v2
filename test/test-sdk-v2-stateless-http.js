import assert from "node:assert/strict";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";

const PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "dc-sdk-v2-stateless-http-probe", version: "1.0.0" };
const envelope = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const factoryEras = [];
let factoryCount = 0;

const handler = createMcpHandler(
  ({ era }) => {
    factoryEras.push(era);
    factoryCount += 1;
    const server = new Server(
      { name: "dc-sdk-v2-stateless-http-fixture", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        supportedProtocolVersions: [PROTOCOL_VERSION],
        cacheHints: {
          "server/discover": { ttlMs: 30_000, cacheScope: "private" },
          "tools/list": { ttlMs: 30_000, cacheScope: "private" },
        },
      },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [{
        name: "stateless_probe",
        description: "Side-effect-free stateless HTTP probe.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    }));
    return server;
  },
  { legacy: "stateless", keepAliveMs: 0 },
);

let requestId = 0;
const post = (body, extraHeaders = {}) => new Request("http://localhost/mcp", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});
const readJsonRpcResponse = async (response) => {
  const body = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    assert.ok(data, "SSE response must contain a data frame");
    return JSON.parse(data);
  }
  return JSON.parse(body);
};
const modernRequest = (method, params = {}) => ({
  jsonrpc: "2.0",
  id: ++requestId,
  method,
  params: { ...params, _meta: envelope },
});

try {
  const discoverResponse = await handler.fetch(post(modernRequest("server/discover"), { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "server/discover" }));
  assert.equal(discoverResponse.status, 200, "modern server/discover must be served over stateless HTTP");
  assert.match(discoverResponse.headers.get("content-type") ?? "", /application\/json/i);
  assert.equal(discoverResponse.headers.get("mcp-session-id"), null, "modern stateless requests must not create an MCP session");
  const discover = await readJsonRpcResponse(discoverResponse);
  assert.ok(discover.result?.supportedVersions?.includes(PROTOCOL_VERSION));
  assert.equal(discover.result?.ttlMs, 30_000);
  assert.equal(discover.result?.cacheScope, "private");
  assert.equal(discover.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "dc-sdk-v2-stateless-http-fixture");

  const toolsResponse = await handler.fetch(post(modernRequest("tools/list"), { "MCP-Protocol-Version": PROTOCOL_VERSION, "Mcp-Method": "tools/list" }));
  assert.equal(toolsResponse.status, 200);
  assert.equal(toolsResponse.headers.get("mcp-session-id"), null);
  const tools = await readJsonRpcResponse(toolsResponse);
  assert.equal(tools.result?.tools?.[0]?.name, "stateless_probe");
  assert.equal(tools.result?.ttlMs, 30_000);
  assert.equal(tools.result?.cacheScope, "private");

  assert.deepEqual(factoryEras, ["modern", "modern"]);
  assert.equal(factoryCount, 2, "each modern HTTP request must receive a fresh server instance");

  const mismatchedHeaderResponse = await handler.fetch(post(modernRequest("tools/list"), {
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Mcp-Method": "resources/list",
  }));
  assert.equal(mismatchedHeaderResponse.status, 400);
  const mismatchedHeader = await readJsonRpcResponse(mismatchedHeaderResponse);
  assert.equal(mismatchedHeader.error?.code, -32020, "Mcp-Method/body mismatch must be rejected");
  assert.equal(factoryCount, 2, "rejected header mismatches must not construct a server instance");

  const legacyInitializeResponse = await handler.fetch(post({
    jsonrpc: "2.0",
    id: ++requestId,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  }));
  assert.equal(legacyInitializeResponse.status, 200);
  assert.equal(legacyInitializeResponse.headers.get("mcp-session-id"), null);
  const legacyInitialize = await readJsonRpcResponse(legacyInitializeResponse);
  assert.equal(legacyInitialize.result?.protocolVersion, "2025-11-25");

  const legacyToolsResponse = await handler.fetch(post({
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/list",
    params: {},
  }));
  assert.equal(legacyToolsResponse.status, 200);
  assert.equal(legacyToolsResponse.headers.get("mcp-session-id"), null);
  const legacyTools = await readJsonRpcResponse(legacyToolsResponse);
  assert.equal(legacyTools.result?.tools?.[0]?.name, "stateless_probe");
  assert.deepEqual(factoryEras, ["modern", "modern", "legacy", "legacy"]);
  assert.equal(factoryCount, 4, "legacy stateless requests must also receive fresh server instances");

  console.log("PASS SDK v2 stateless HTTP E2E: server/discover, modern per-request envelope, no session IDs, and 2025 stateless fallback");
} finally {
  await handler.close().catch(() => {});
}
