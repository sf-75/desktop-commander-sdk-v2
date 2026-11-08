import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createTaskSessionFromClient } from "@modelcontextprotocol/ext-tasks/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "fixtures", "sdk-v2-tasks-server.js");
const PROTOCOL_VERSION = "2026-07-28";
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const TOOL_NAME = "sdk_v2_task_demo";
const CLIENT_INFO = { name: "dc-sdk-v2-task-sdk-adapter-client", version: "1.0.0" };

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: "true" },
  stderr: "pipe",
});
const client = new Client(
  CLIENT_INFO,
  {
    capabilities: {},
    versionNegotiation: { mode: "auto" },
  },
);

let rawRequestId = 0;
const pendingRaw = new Map();
const rawDispatches = [];
const previousOnMessage = undefined;

function installRawDispatchRouter() {
  const sdkOnMessage = transport.onmessage;
  assert.equal(typeof sdkOnMessage, "function", "SDK Client must install a transport message handler");
  transport.onmessage = (message, extra) => {
    if (message && typeof message === "object" && "id" in message && pendingRaw.has(message.id)) {
      const waiter = pendingRaw.get(message.id);
      pendingRaw.delete(message.id);
      if (message.error) waiter.resolve({ kind: "error", error: message.error });
      else waiter.resolve({ kind: "result", result: message.result });
      return;
    }
    sdkOnMessage(message, extra);
  };
}

async function rawDispatch(request, options = {}) {
  if (!request || typeof request !== "object" || typeof request.method !== "string") {
    throw new TypeError("rawDispatch expects a method-bearing JSON-RPC request");
  }
  const id = "ext-tasks-v2-raw-" + (++rawRequestId);
  const message = { ...request, jsonrpc: "2.0", id };
  const meta = message.params?._meta;
  const clientCapabilities = meta?.["io.modelcontextprotocol/clientCapabilities"];
  const hasTasksCapability = Boolean(clientCapabilities?.extensions?.[TASKS_EXTENSION]);
  const mcpName = options.context?.headers?.["Mcp-Name"] ?? options.context?.headers?.["mcp-name"] ?? null;
  const taskId = typeof message.params?.taskId === "string" ? message.params.taskId : null;
  rawDispatches.push({ method: message.method, hasTasksCapability, mcpName, taskId });

  let timer;
  const responsePromise = new Promise((resolve, reject) => {
    const onAbort = () => {
      pendingRaw.delete(id);
      reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    pendingRaw.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const waiter = pendingRaw.get(id);
      if (!waiter) return;
      pendingRaw.delete(id);
      waiter.reject(new Error("Timed out waiting for raw Tasks V2 response: " + message.method));
    }, options.context?.requestTimeoutMs ?? 15_000);
  });

  try {
    await transport.send(message);
  } catch (error) {
    pendingRaw.delete(id);
    throw error;
  }
  return responsePromise;
}

try {
  await client.connect(transport, { timeout: 15_000 });
  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), PROTOCOL_VERSION);
  assert.ok(client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION]);

  const { tools } = await client.listTools({}, { cacheMode: "bypass" });
  const mcpTool = tools.find((tool) => tool.name === TOOL_NAME);
  assert.ok(mcpTool, "SDK Client must list the Tasks V2 test tool");
  assert.equal(mcpTool.execution, undefined, "Tasks V2 opt-in is per-request; legacy execution.taskSupport is not required");
  // This local declaration expresses application policy; Tasks V2 itself is opted into per request.
  const declaration = {
    name: mcpTool.name,
    description: mcpTool.description,
    inputSchema: mcpTool.inputSchema,
    taskSupport: "optional",
  };

  assert.throws(
    () => createTaskSessionFromClient(client, { endpointId: "missing-v2-raw-dispatch" }),
    /requires options\.rawDispatch and options\.v2RequestFraming/,
    "V2 task adapter must refuse to guess raw request framing",
  );

  installRawDispatchRouter();
  let inputRequestsHandled = 0;
  const session = createTaskSessionFromClient(client, {
    endpointId: "dc-sdk-v2-tasks-sdk-client-adapter",
    rawDispatch,
    v2RequestFraming: {
      protocolVersion: client.getNegotiatedProtocolVersion(),
      clientInfo: CLIENT_INFO,
      clientCapabilities: {},
    },
    tools: {
      currentTool(name) {
        return name === TOOL_NAME ? declaration : undefined;
      },
    },
    onInputRequest: async (request) => {
      assert.equal(request.kind, "elicitation");
      assert.match(request.params.message, /harmless test task/);
      inputRequestsHandled += 1;
      return { action: "accept", content: { approved: true } };
    },
  });

  try {
    assert.deepEqual(session.capabilities, {
      inventory: "known-handles",
      execution: true,
      cancellation: true,
      inputResponses: true,
      requestedRetention: false,
    });

    const poll = await session.callTool(TOOL_NAME, { mode: "poll" }, { task: { preference: "prefer" } });
    assert.equal(poll.kind, "task");
    const pollOutcome = await poll.result();
    assert.equal(pollOutcome.status, "completed");
    assert.match(pollOutcome.result.content[0].text, /Task completed: poll/);

    const input = await session.callTool(TOOL_NAME, { mode: "input" }, { task: { preference: "prefer" } });
    assert.equal(input.kind, "task");
    const inputOutcome = await input.result();
    assert.equal(inputOutcome.status, "completed");
    assert.match(inputOutcome.result.content[0].text, /Task completed: input/);
    assert.equal(inputRequestsHandled, 1);

    const cancel = await session.callTool(TOOL_NAME, { mode: "cancel" }, { task: { preference: "prefer" } });
    assert.equal(cancel.kind, "task");
    await cancel.cancel();
    assert.equal((await cancel.result()).status, "cancelled");

    for (const method of ["tools/call", "tasks/get", "tasks/update", "tasks/cancel"]) {
      assert.ok(
        rawDispatches.some((entry) => entry.method === method && entry.hasTasksCapability),
        method + " must use raw V2 dispatch with the per-request Tasks capability",
      );
    }
    assert.ok(rawDispatches.every((entry) => entry.hasTasksCapability));
    for (const entry of rawDispatches.filter((item) => item.method.startsWith("tasks/"))) {
      assert.ok(entry.taskId, entry.method + " must include a taskId");
      assert.equal(entry.mcpName, entry.taskId, entry.method + " must route with the required Mcp-Name header");
    }
  } finally {
    await session.close();
  }

  console.log("PASS SDK Client Tasks V2 adapter E2E: modern negotiation, explicit raw framing, tool declaration, polling, input/update, cancellation");
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
