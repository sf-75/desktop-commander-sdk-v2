import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildEventProperties, getTelemetryRequestContext, runWithTelemetryRequestContext } from "../dist/utils/capture.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const remoteCall = runWithTelemetryRequestContext({
  client: { name: "local-host", version: "9" },
  remote: true,
  remoteClient: { name: "remote-alpha", version: "1" },
}, async () => {
  await pause(30);
  const context = getTelemetryRequestContext();
  assert.deepEqual(context.client, { name: "local-host", version: "9" });
  assert.equal(context.remote, true);
  assert.deepEqual(context.remoteClient, { name: "remote-alpha", version: "1" });
  const properties = await buildEventProperties();
  assert.equal(properties.client_name, "remote-alpha");
  assert.equal(properties.client_version, "1");
  return context;
});

const localCall = runWithTelemetryRequestContext({
  client: { name: "local-beta", version: "2" },
  remote: false,
  remoteClient: null,
}, async () => {
  await pause(5);
  const context = getTelemetryRequestContext();
  assert.deepEqual(context.client, { name: "local-beta", version: "2" });
  assert.equal(context.remote, false);
  assert.equal(context.remoteClient, null);
  const properties = await buildEventProperties();
  assert.equal(properties.client_name, "local-beta");
  assert.equal(properties.client_version, "2");
  return context;
});

const [remote, local] = await Promise.all([remoteCall, localCall]);
assert.equal(remote.remoteClient.name, "remote-alpha");
assert.equal(local.client.name, "local-beta");

const serverSource = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const initializeStart = serverSource.indexOf("export function handleInitializedClient");
const initializeEnd = serverSource.indexOf("// Export current client info", initializeStart);
assert(initializeStart >= 0 && initializeEnd > initializeStart, "handleInitializedClient source block must exist");
const initializeSource = serverSource.slice(initializeStart, initializeEnd);
assert.match(
  initializeSource,
  /const telemetryContext = \{\s*client:\s*clientInfo/,
  "initialization must create telemetry context from the initializing Server's client identity",
);
assert.equal(
  (initializeSource.match(/runWithTelemetryRequestContext\(telemetryContext/g) ?? []).length,
  2,
  "both onboarding and initialization telemetry must use the initializing Server's context",
);

console.log("PASS: overlapping tool-call and per-Server initialization telemetry contexts remain isolated");
