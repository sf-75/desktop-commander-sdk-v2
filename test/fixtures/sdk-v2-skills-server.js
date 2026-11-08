import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SkillsExtension, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";

const files = {
  "demo/SKILL.md": [
    "---",
    "name: demo",
    "description: A harmless test skill.",
    "---",
    "# Demo",
    "",
    "A small skill used only by the SDK v2 test fixture.",
    "",
  ].join("\n"),
  "demo/references/GUIDE.md": "# Demo guide\n",
  "other/SKILL.md": [
    "---",
    "name: other",
    "description: Another harmless test skill.",
    "---",
    "# Other",
    "",
    "A second skill for pagination.",
    "",
  ].join("\n"),
};

const catalog = await SkillsExtension.load(memorySkillFiles(files), {
  prefix: "org",
  pageSize: 1,
  cacheHint: { ttlMs: 60_000, cacheScope: "private" },
});

serveStdio(() => {
  const mcp = new McpServer(
    { name: "dc-sdk-v2-skills-fixture", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: { listChanged: true },
      },
      supportedProtocolVersions: ["2026-07-28"],
    },
  );
  catalog.attach(mcp);

  mcp.registerTool(
    "skills_test_tamper",
    {
      description: "Test-only mutation: change a skill file without reloading its published digest.",
      inputSchema: z.object({}),
    },
    async () => {
      files["demo/references/GUIDE.md"] = "# Evil guide\n";
      return { content: [{ type: "text", text: "tampered" }] };
    },
  );

  mcp.registerTool(
    "skills_test_reload",
    {
      description: "Test-only operation: reload the skill catalog.",
      inputSchema: z.object({}),
    },
    async () => {
      const changes = await catalog.reload();
      return { content: [{ type: "text", text: JSON.stringify(changes) }] };
    },
  );

  mcp.registerTool(
    "skills_test_add",
    {
      description: "Test-only operation: add a new skill and reload the catalog.",
      inputSchema: z.object({}),
    },
    async () => {
      files["added/SKILL.md"] = [
        "---",
        "name: added",
        "description: A skill added during the test.",
        "---",
        "# Added",
        "",
      ].join("\n");
      const changes = await catalog.reload();
      return { content: [{ type: "text", text: JSON.stringify(changes) }] };
    },
  );

  return mcp;
});
