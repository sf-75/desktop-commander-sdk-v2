import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, "..", "dist", "index.js");
const labResourceUri = "ui://desktop-commander/chatgpt-capability-lab-v9";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, "--no-onboarding"],
  env: {
    ...process.env,
    DC_REMOTE_DEVICE: "true",
    DC_SDK_V2_EXPERIMENTAL_MRTR: "1",
    DC_SDK_V2_PLAYGROUND: "1",
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: "true",
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "dc-sdk-v2-modern-probe", version: "1.0.0" },
  {
    capabilities: { roots: { listChanged: true } },
    versionNegotiation: { mode: "auto" },
  },
);

const waitFor = async (predicate, label, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const getDiagnostics = async () => {
  const result = await client.callTool({
    name: "get_config",
    arguments: { origin: "llm" },
  });
  assert.notEqual(result.isError, true, "get_config should return diagnostics");
  assert.ok(result.structuredContent?.playgroundDiagnostics);
  return result.structuredContent.playgroundDiagnostics;
};

try {
  await client.connect(transport, { timeout: 30_000 });

  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

  const identityDiagnostics = await getDiagnostics();
  assert.deepEqual(
    identityDiagnostics.clientVersion,
    { name: "dc-sdk-v2-modern-probe", version: "1.0.0" },
    "modern stdio must expose envelope clientInfo to Desktop Commander's per-request client identity",
  );
  assert.deepEqual(
    identityDiagnostics.clientCapabilities?.topLevelKeys,
    ["roots"],
    "modern stdio must expose envelope clientCapabilities to Desktop Commander's per-request capability checks",
  );

  const discover = client.getDiscoverResult();
  assert.ok(discover?.supportedVersions.includes("2026-07-28"));
  assert.equal(discover?.ttlMs, 30_000);
  assert.equal(discover?.cacheScope, "private");
  assert.equal(discover?.capabilities?.tasks, undefined, "DC must not advertise deprecated Tasks support");
  assert.equal(discover?.capabilities?.extensions?.["io.modelcontextprotocol/tasks"], undefined, "DC must not advertise Tasks V2 until the connected host opts in");
  assert.equal(discover?.capabilities?.tools?.listChanged, true);
  assert.equal(discover?.capabilities?.resources?.listChanged, true);
  assert.equal(discover?.capabilities?.resources?.subscribe, true);
  assert.equal(discover?.capabilities?.prompts?.listChanged, undefined);

  const { tools, ttlMs: toolsTtlMs, cacheScope: toolsCacheScope } =
    await client.listTools({}, { cacheMode: "use" });
  assert.equal(toolsTtlMs, 30_000);
  assert.equal(toolsCacheScope, "private");
  const cachedTools = await client.listTools({}, { cacheMode: "use" });
  assert.deepEqual(cachedTools.tools, tools);
  assert.ok(
    tools.some((tool) => tool.name === "sdk_v2_multi_round_trip_demo"),
    "native MRTR tool should be available on the modern protocol",
  );
  const labTool = tools.find((tool) => tool.name === "sdk_v2_chatgpt_capability_lab");
  assert.equal(labTool?._meta?.["ui/resourceUri"], labResourceUri);
  assert.equal(labTool?._meta?.ui?.resourceUri, labResourceUri);

  const { resources, ttlMs: resourcesTtlMs, cacheScope: resourcesCacheScope } =
    await client.listResources({}, { cacheMode: "use" });
  assert.equal(resourcesTtlMs, 30_000);
  assert.equal(resourcesCacheScope, "private");
  const cachedResources = await client.listResources({}, { cacheMode: "use" });
  assert.deepEqual(cachedResources.resources, resources);
  assert.ok(resources.some((resource) => resource.uri === labResourceUri));

  const beforeRead = await getDiagnostics();
  const resource = await client.readResource({ uri: labResourceUri }, { cacheMode: "use" });
  assert.equal(resource.contents?.[0]?.uri, labResourceUri);
  assert.equal(resource.ttlMs, 60_000);
  assert.equal(resource.cacheScope, "private");
  assert.ok(resource.contents?.[0]?.text?.includes('data-tab="basic"'));
  assert.ok(resource.contents?.[0]?.text?.includes("labBuildVersion:9"));
  const afterFirstRead = await getDiagnostics();
  assert.equal(afterFirstRead.resourceReadCount, beforeRead.resourceReadCount + 1);

  const cachedResource = await client.readResource({ uri: labResourceUri }, { cacheMode: "use" });
  assert.equal(cachedResource.contents?.[0]?.text, resource.contents?.[0]?.text);
  const afterCachedRead = await getDiagnostics();
  assert.equal(
    afterCachedRead.resourceReadCount,
    afterFirstRead.resourceReadCount,
    "a fresh private resource cache entry must avoid a second server read",
  );

  const notifications = { tools: 0, resources: 0, updated: [] };
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications.tools += 1;
  });
  client.setNotificationHandler("notifications/resources/list_changed", () => {
    notifications.resources += 1;
  });
  client.setNotificationHandler("notifications/resources/updated", (notification) => {
    notifications.updated.push(notification.params.uri);
  });

  const subscription = await client.listen(
    {
      toolsListChanged: true,
      promptsListChanged: true,
      resourcesListChanged: true,
      resourceSubscriptions: [labResourceUri],
    },
    { timeout: 5_000 },
  );
  assert.deepEqual(subscription.honoredFilter, {
    toolsListChanged: true,
    resourcesListChanged: true,
    resourceSubscriptions: [labResourceUri],
  });
  assert.equal(client.autoOpenedSubscription, undefined);

  await client.callTool({
    name: "sdk_v2_chatgpt_capability_lab",
    arguments: {},
  });
  await waitFor(
    () => notifications.tools === 1 && notifications.resources === 1 && notifications.updated.length === 1,
    "DC dynamic tool/resource notifications",
  );
  assert.deepEqual(
    notifications.updated,
    [labResourceUri],
    "the legacy v6 resource update must be filtered out because only v7 is subscribed",
  );

  const refreshedResource = await client.readResource({ uri: labResourceUri }, { cacheMode: "use" });
  assert.equal(refreshedResource.contents?.[0]?.text, resource.contents?.[0]?.text);
  const afterNotificationRead = await getDiagnostics();
  assert.equal(
    afterNotificationRead.resourceReadCount,
    afterCachedRead.resourceReadCount + 1,
    "resources/updated must invalidate the cached v7 resource before the next read",
  );

  const refreshedTools = await client.listTools({}, { cacheMode: "use" });
  assert.ok(refreshedTools.tools.some((tool) => tool.name === "sdk_v2_chatgpt_capability_lab"));
  const refreshedResources = await client.listResources({}, { cacheMode: "use" });
  assert.ok(refreshedResources.resources.some((item) => item.uri === labResourceUri));

  await subscription.close();
  assert.equal(await subscription.closed, "local");

  console.log(
    "PASS SDK v2 modern protocol: discover/cache hints, advertised subscriptions, actual DC notifications, exact URI filtering, and resource-cache invalidation",
  );
} finally {
  await client.close().catch(() => {});
}