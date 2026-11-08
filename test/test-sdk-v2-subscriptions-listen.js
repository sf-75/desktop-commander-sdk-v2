import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "fixtures", "sdk-v2-subscriptions-server.js");
const RESOURCE_URI = "test://dc-sdk-v2/subscription-resource";
const waitFor = async (predicate, label, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function connectClient(options = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: "true" },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "dc-sdk-v2-subscriptions-e2e-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" }, ...options },
  );
  await client.connect(transport, { timeout: 15_000 });
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  return { client, transport };
}

const manual = await connectClient();
try {
  const events = { tools: 0, resources: 0, updated: [] };
  manual.client.setNotificationHandler("notifications/tools/list_changed", () => {
    events.tools += 1;
  });
  manual.client.setNotificationHandler("notifications/resources/list_changed", () => {
    events.resources += 1;
  });
  manual.client.setNotificationHandler("notifications/resources/updated", (notification) => {
    events.updated.push(notification.params.uri);
  });

  const initialTools = await manual.client.listTools({}, { cacheMode: "use" });
  const cachedTools = await manual.client.listTools({}, { cacheMode: "use" });
  assert.equal(initialTools.tools.find((tool) => tool.name === "stable_tool").description, "catalog-read-1");
  assert.equal(cachedTools.tools.find((tool) => tool.name === "stable_tool").description, "catalog-read-1");
  assert.equal(initialTools.ttlMs, 60_000);
  assert.equal(initialTools.cacheScope, "private");

  const initialResources = await manual.client.listResources({}, { cacheMode: "use" });
  const cachedResources = await manual.client.listResources({}, { cacheMode: "use" });
  assert.equal(initialResources.resources[0].name, "resource-list-read-1");
  assert.equal(cachedResources.resources[0].name, "resource-list-read-1");
  assert.equal(initialResources.ttlMs, 60_000);
  assert.equal(initialResources.cacheScope, "private");

  const initialResource = await manual.client.readResource({ uri: RESOURCE_URI }, { cacheMode: "use" });
  const cachedResource = await manual.client.readResource({ uri: RESOURCE_URI }, { cacheMode: "use" });
  assert.equal(initialResource.contents[0].text, "resource-version-1-read-1");
  assert.equal(cachedResource.contents[0].text, "resource-version-1-read-1");
  assert.equal(initialResource.ttlMs, 60_000);
  assert.equal(initialResource.cacheScope, "private");

  const subscription = await manual.client.listen({
    toolsListChanged: true,
    promptsListChanged: true,
    resourcesListChanged: true,
    resourceSubscriptions: [RESOURCE_URI],
  }, { timeout: 5_000 });

  assert.deepEqual(subscription.honoredFilter, {
    toolsListChanged: true,
    resourcesListChanged: true,
    resourceSubscriptions: [RESOURCE_URI],
  }, "the server must honor only the advertised notification types");

  await manual.client.callTool({ name: "trigger_changes", arguments: {} });
  await waitFor(
    () => events.tools === 1 && events.resources === 1 && events.updated.length === 1,
    "filtered tool/resource change notifications",
  );

  assert.deepEqual(events.updated, [RESOURCE_URI], "resource updates must match the subscribed URI exactly");

  const refreshedTools = await manual.client.listTools({}, { cacheMode: "use" });
  assert.ok(refreshedTools.tools.some((tool) => tool.name === "dynamic_tool_v2"), "list_changed must evict the cached tool catalog");
  assert.equal(refreshedTools.tools.find((tool) => tool.name === "stable_tool").description, "catalog-read-2");

  const refreshedResources = await manual.client.listResources({}, { cacheMode: "use" });
  assert.equal(refreshedResources.resources[0].name, "resource-list-read-2", "resources/list cache must be evicted after its change notification");

  const refreshedResource = await manual.client.readResource({ uri: RESOURCE_URI }, { cacheMode: "use" });
  assert.equal(refreshedResource.contents[0].text, "resource-version-2-read-2", "resources/updated must evict only the subscribed resource cache entry");

  await subscription.close();
  assert.equal(await subscription.closed, "local");
  const beforeClosedTrigger = { ...events, updated: [...events.updated] };
  await manual.client.callTool({ name: "trigger_changes", arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(events, beforeClosedTrigger, "closed subscriptions must not receive later notifications");

  console.log("PASS manual subscriptions/listen: capability intersection, dynamic tool list, exact resource URI filtering, and close");
} finally {
  await manual.client.close().catch(() => {});
  await manual.transport.close().catch(() => {});
}

const automaticUpdates = { tools: undefined, resources: undefined, errors: [] };
const automatic = await connectClient({
  listChanged: {
    tools: {
      onChanged(error, tools) {
        if (error) automaticUpdates.errors.push(error.message);
        else automaticUpdates.tools = tools;
      },
    },
    resources: {
      onChanged(error, resources) {
        if (error) automaticUpdates.errors.push(error.message);
        else automaticUpdates.resources = resources;
      },
    },
  },
});
try {
  const autoSubscription = automatic.client.autoOpenedSubscription;
  assert.ok(autoSubscription, "ClientOptions.listChanged must auto-open a modern subscriptions/listen stream");
  assert.deepEqual(autoSubscription.honoredFilter, {
    toolsListChanged: true,
    resourcesListChanged: true,
  });

  await automatic.client.callTool({ name: "trigger_changes", arguments: {} });
  await waitFor(
    () => automaticUpdates.tools?.some((tool) => tool.name === "dynamic_tool_v2") &&
      automaticUpdates.resources?.some((resource) => resource.uri === RESOURCE_URI),
    "automatic catalog refresh callbacks",
  );
  assert.deepEqual(automaticUpdates.errors, []);

  await autoSubscription.close();
  console.log("PASS automatic listChanged: SDK opened subscriptions/listen and refreshed tool/resource catalogs");
} finally {
  await automatic.client.close().catch(() => {});
  await automatic.transport.close().catch(() => {});
}