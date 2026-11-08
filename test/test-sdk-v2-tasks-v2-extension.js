import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { withTasks } from "@modelcontextprotocol/ext-tasks/client";
import { hasTaskServerCapabilityV2 } from "@modelcontextprotocol/ext-tasks/core/v2";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "fixtures", "sdk-v2-tasks-server.js");
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const TOOL_NAME = "sdk_v2_task_demo";
const PROTOCOL_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "dc-sdk-v2-tasks-e2e-client", version: "1.0.0" };
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: "true" },
  stderr: "pipe",
});

let nextId = 0;
let closed = false;
const pending = new Map();
const notificationListeners = new Set();
const invalidationListeners = new Set();
const dispatched = [];

transport.onmessage = (message) => {
  if (message && typeof message === "object" && "id" in message && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.resolve({ kind: "error", error: message.error });
    else waiter.resolve({ kind: "result", result: message.result });
    return;
  }
  for (const listener of [...notificationListeners]) listener(message);
};

transport.onclose = () => {
  closed = true;
  for (const waiter of pending.values()) waiter.reject(new Error("Tasks E2E stdio transport closed."));
  pending.clear();
  for (const listener of [...invalidationListeners]) listener(new Error("Tasks E2E transport closed."));
};

transport.onerror = (error) => {
  for (const listener of [...invalidationListeners]) listener(error);
};

async function dispatchRaw(request, { includeTasks = true, signal } = {}) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const id = ++nextId;
  const params = request.params && typeof request.params === "object" ? structuredClone(request.params) : {};
  const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
  const existingCapabilities = meta[CLIENT_CAPABILITIES_KEY] && typeof meta[CLIENT_CAPABILITIES_KEY] === "object"
    ? meta[CLIENT_CAPABILITIES_KEY]
    : {};
  const extensions = { ...(existingCapabilities.extensions ?? {}) };
  if (includeTasks) extensions[TASKS_EXTENSION] = {};
  else delete extensions[TASKS_EXTENSION];

  params._meta = {
    ...meta,
    [PROTOCOL_VERSION_KEY]: PROTOCOL_VERSION,
    [CLIENT_INFO_KEY]: CLIENT_INFO,
    [CLIENT_CAPABILITIES_KEY]: { ...existingCapabilities, extensions },
  };

  const message = { jsonrpc: "2.0", id, method: request.method, params };
  dispatched.push({ method: request.method, params: structuredClone(params) });

  const responsePromise = new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  try {
    await transport.send(message);
  } catch (error) {
    pending.delete(id);
    throw error;
  }
  return responsePromise;
}

try {
  await transport.start();

  const discoverResponse = await dispatchRaw({ method: "server/discover", params: {} });
  assert.equal(discoverResponse.kind, "result");
  const discover = discoverResponse.result;
  assert.ok(discover.supportedVersions.includes(PROTOCOL_VERSION));
  assert.ok(discover.capabilities.extensions[TASKS_EXTENSION]);
  assert.equal(hasTaskServerCapabilityV2(discover.capabilities), true);

  const toolsResponse = await dispatchRaw({ method: "tools/list", params: {} });
  assert.equal(toolsResponse.kind, "result");
  const listedTaskTool = toolsResponse.result.tools.find((tool) => tool.name === TOOL_NAME);
  assert.ok(listedTaskTool, "task demo tool must be discoverable");
  assert.equal(listedTaskTool.execution, undefined, "V2 Tasks negotiation is per-request and must not depend on legacy execution.taskSupport metadata");

  const immediateResponse = await dispatchRaw(
    { method: "tools/call", params: { name: TOOL_NAME, arguments: { mode: "poll" } } },
    { includeTasks: false },
  );
  assert.equal(immediateResponse.kind, "result");
  assert.match(immediateResponse.result.content[0].text, /Tasks extension was not requested/);
  assert.equal(immediateResponse.result.resultType, "complete");

  const port = {
    endpointId: "dc-sdk-v2-tasks-e2e",
    taskCapabilities: {
      generation: "v2",
      capabilities: discover.capabilities.extensions[TASKS_EXTENSION],
    },
    dispatch: (request, options = {}) => dispatchRaw(request, options),
    onServerRequest: () => () => {},
    onNotification: (listener) => {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onInvalidated: (listener) => {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    get invalidated() {
      return closed;
    },
  };

  let inputRequestsHandled = 0;
  const declaration = {
    name: TOOL_NAME,
    description: "Side-effect-free Tasks V2 test tool.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["poll", "input", "cancel"] } },
      additionalProperties: false,
    },
    taskSupport: "optional",
  };
  const session = withTasks(port, {
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

    const pollExecution = await session.callTool(
      TOOL_NAME,
      { mode: "poll" },
      { task: { preference: "prefer" } },
    );
    assert.equal(pollExecution.kind, "task");
    const pollSettlement = await pollExecution.settle();
    assert.equal(pollSettlement.outcome.status, "completed");
    assert.match(pollSettlement.outcome.result.content[0].text, /Task completed: poll/);

    const inputExecution = await session.callTool(
      TOOL_NAME,
      { mode: "input" },
      { task: { preference: "prefer" } },
    );
    assert.equal(inputExecution.kind, "task");
    const inputSettlement = await inputExecution.settle();
    assert.equal(inputSettlement.outcome.status, "completed", inputSettlement.outcome.error?.message ?? JSON.stringify(inputSettlement.outcome));
    assert.match(inputSettlement.outcome.result.content[0].text, /Task completed: input/);
    assert.equal(inputRequestsHandled, 1);

    const cancelExecution = await session.callTool(
      TOOL_NAME,
      { mode: "cancel" },
      { task: { preference: "prefer" } },
    );
    assert.equal(cancelExecution.kind, "task");
    await cancelExecution.cancel();
    const cancelOutcome = await cancelExecution.result();
    assert.equal(cancelOutcome.status, "cancelled");

    const methods = dispatched.map((item) => item.method);
    assert.ok(methods.includes("tasks/get"));
    assert.ok(methods.includes("tasks/update"));
    assert.ok(methods.includes("tasks/cancel"));
    assert.equal(methods.includes("tasks/list"), false);
    assert.equal(methods.includes("tasks/result"), false);

    const taskFollowUps = dispatched.filter((item) => ["tasks/get", "tasks/update", "tasks/cancel"].includes(item.method));
    assert.ok(taskFollowUps.length > 0);
    for (const item of taskFollowUps) {
      assert.ok(
        item.params._meta[CLIENT_CAPABILITIES_KEY].extensions[TASKS_EXTENSION],
        item.method + " must carry the per-request Tasks capability",
      );
    }
  } finally {
    await session.close();
  }

  console.log("PASS SDK v2 Tasks extension E2E: discover, opt-in, task creation, polling, input/update, cancellation, and no legacy list/result methods");
} finally {
  await transport.close().catch(() => {});
}