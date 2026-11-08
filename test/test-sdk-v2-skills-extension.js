import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SkillsClient, SKILLS_EXTENSION_ID } from "@modelcontextprotocol/client/ext/skills";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "fixtures", "sdk-v2-skills-server.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: "true" },
  stderr: "pipe",
});
const client = new Client(
  { name: "dc-sdk-v2-skills-client", version: "1.0.0" },
  { capabilities: {}, versionNegotiation: { mode: "auto" } },
);
const waitFor = async (predicate, label, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for " + label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

try {
  await client.connect(transport, { timeout: 15_000 });
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");

  const capability = client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION_ID];
  assert.ok(capability, "server must advertise the MCP Skills extension");
  assert.equal(capability.directoryRead, true);

  const skills = new SkillsClient(client);
  assert.equal(skills.supported, true);
  assert.equal(skills.directoryRead, true);

  const listing = await skills.list({}, { cacheMode: "use" });
  assert.deepEqual(listing.invalid, []);
  assert.equal(listing.skills.length, 2, "SkillsClient.list must walk every page");
  assert.equal(listing.ttlMs, 60_000);
  assert.equal(listing.cacheScope, "private");
  assert.deepEqual(listing.skills.map((skill) => skill.frontmatter.name), ["demo", "other"]);

  const demo = listing.skills.find((skill) => skill.frontmatter.name === "demo");
  assert.ok(demo);
  assert.equal(demo.uri, "skill://org/demo/SKILL.md");

  const fetched = await skills.get(demo.uri);
  assert.equal(fetched.skill.uri, demo.uri);
  assert.equal(fetched.ttlMs, 60_000);
  assert.equal(fetched.cacheScope, "private");

  const manifest = await skills.read(demo);
  assert.equal(manifest.verified, true);
  assert.equal(manifest.uri, demo.uri);
  assert.equal(manifest.frontmatter?.name, "demo");
  assert.match(manifest.body ?? "", /small skill used only by the SDK v2 test fixture/);

  const guide = await skills.read(demo, "references/GUIDE.md");
  assert.equal(guide.verified, true);
  assert.equal(guide.text, "# Demo guide\n");

  const directory = await skills.readDirectory("skill://org/demo");
  assert.equal(directory.ttlMs, 60_000);
  assert.equal(directory.cacheScope, "private");
  assert.ok(directory.resources.some((resource) => resource.uri.endsWith("/SKILL.md")));
  assert.ok(directory.resources.some((resource) => resource.uri === "skill://org/demo/references"));

  const events = { resources: 0 };
  client.setNotificationHandler("notifications/resources/list_changed", () => {
    events.resources += 1;
  });
  const subscription = await client.listen({ resourcesListChanged: true }, { timeout: 5_000 });
  assert.deepEqual(subscription.honoredFilter, { resourcesListChanged: true });

  const tamper = await client.callTool({ name: "skills_test_tamper", arguments: {} });
  assert.notEqual(tamper.isError, true);
  await assert.rejects(
    () => skills.read(demo, "references/GUIDE.md", { cacheMode: "refresh" }),
    (error) => {
      assert.equal(error?.name, "ProtocolError");
      assert.match(error?.message ?? "", /changed since the skills catalog was loaded/);
      return true;
    },
    "server must refuse to serve a skill file whose bytes no longer match the published digest",
  );

  const reload = await client.callTool({ name: "skills_test_reload", arguments: {} });
  const reloadChanges = JSON.parse(reload.content?.[0]?.text ?? "{}");
  assert.equal(reloadChanges.listChanged, false);
  assert.ok(reloadChanges.changed.includes("skill://org/demo/SKILL.md"));

  const refreshedDemo = (await skills.get(demo.uri, { cacheMode: "refresh" })).skill;
  const updatedGuide = await skills.read(refreshedDemo, "references/GUIDE.md", { cacheMode: "refresh" });
  assert.equal(updatedGuide.verified, true);
  assert.equal(updatedGuide.text, "# Evil guide\n");

  const add = await client.callTool({ name: "skills_test_add", arguments: {} });
  const addChanges = JSON.parse(add.content?.[0]?.text ?? "{}");
  assert.equal(addChanges.listChanged, true);
  assert.ok(addChanges.added.includes("skill://org/added/SKILL.md"));
  await waitFor(() => events.resources === 1, "resources/list_changed after skill catalog addition");

  const refreshed = await skills.list({}, { cacheMode: "use" });
  assert.equal(refreshed.skills.length, 3, "catalog notification must invalidate the cached Skills listing");
  assert.ok(refreshed.skills.some((skill) => skill.frontmatter.name === "added"));

  await subscription.close();
  assert.equal(await subscription.closed, "local");

  console.log("PASS SDK v2 Skills extension E2E: paginated list, get, digest/frontmatter verification, directory read, cache hints, catalog reload, and change notification");
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
