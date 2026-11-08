import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CreateTaskResultV2Schema, GetTaskResultV2Schema, UpdateTaskResultV2Schema, CancelTaskResultV2Schema, isCreateTaskResultV2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import { z } from "zod";

const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const TOOL_NAME = "sdk_v2_task_demo";
const tasks = new Map();

class TasksExtensionServer extends Server {
  _wrapHandler(method, handler) {
    if (method !== "tools/call") return super._wrapHandler(method, handler);
    const rawResults = new WeakMap();
    const capture = async (request, context) => {
      const result = await handler(request, context);
      if (result && typeof result === "object") rawResults.set(request, result);
      return result;
    };
    const standard = super._wrapHandler(method, capture);
    return async (request, context) => {
      try {
        return await standard(request, context);
      } catch (error) {
        const candidate = rawResults.get(request);
        if (
          this.getNegotiatedProtocolVersion() === "2026-07-28" &&
          isCreateTaskResultV2(candidate)
        ) {
          return CreateTaskResultV2Schema.parse(candidate);
        }
        throw error;
      } finally {
        rawResults.delete(request);
      }
    };
  }
}

const server = new TasksExtensionServer(
  { name: "dc-sdk-v2-tasks-e2e", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      extensions: { [TASKS_EXTENSION]: {} },
    },
    supportedProtocolVersions: ["2026-07-28"],
  },
);

server.setRequestHandler("tools/list", async () => ({
  tools: [{
    name: TOOL_NAME,
    description: "Side-effect-free Tasks V2 test tool.",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["poll", "input", "cancel"] } },
      additionalProperties: false,
    },
    execution: { taskSupport: "optional" },
  }],
}));

server.setRequestHandler("tools/call", async (request, context) => {
  const { name, arguments: args = {} } = request.params ?? {};
  if (name !== TOOL_NAME) {
    return { content: [{ type: "text", text: "Unknown test tool." }], isError: true };
  }

  const clientCapabilities = context.mcpReq?.envelope?.["io.modelcontextprotocol/clientCapabilities"];
  const extensions = clientCapabilities?.extensions;
  if (!extensions || !Object.hasOwn(extensions, TASKS_EXTENSION)) {
    return {
      content: [{ type: "text", text: "Immediate result: Tasks extension was not requested." }],
      isError: false,
    };
  }

  const mode = ["poll", "input", "cancel"].includes(args.mode) ? args.mode : "poll";
  const taskId = randomUUID();
  const timestamp = new Date().toISOString();
  tasks.set(taskId, {
    taskId,
    mode,
    status: "working",
    createdAt: timestamp,
    lastUpdatedAt: timestamp,
    ttlMs: 60_000,
    pollIntervalMs: 10,
    polls: 0,
    updates: 0,
  });

  return CreateTaskResultV2Schema.parse({
    resultType: "task",
    taskId,
    status: "working",
    createdAt: timestamp,
    lastUpdatedAt: timestamp,
    ttlMs: 60_000,
    pollIntervalMs: 10,
  });
});

server.setRequestHandler(
  "tasks/get",
  { params: z.object({ taskId: z.string() }) },
  async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error("Unknown task.");
    task.polls += 1;

    if (task.mode === "input" && task.updates === 0 && task.polls >= 1) {
      task.status = "input_required";
      task.inputRequests = {
        approval: {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Approve completion of this harmless test task?",
            requestedSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
              required: ["approved"],
              additionalProperties: false,
            },
          },
        },
      };
    } else if (
      (task.mode === "poll" && task.polls >= 2) ||
      (task.mode === "input" && task.updates >= 1)
    ) {
      task.status = "completed";
      task.result = {
        resultType: "complete",
        content: [{ type: "text", text: "Task completed: " + task.mode }],
        isError: false,
      };
      delete task.inputRequests;
    }

    task.lastUpdatedAt = new Date().toISOString();
    const { taskId: id, mode, polls, updates, ...wireTask } = task;
    return GetTaskResultV2Schema.parse({
      resultType: "complete",
      taskId: id,
      ...wireTask,
    });
  },
);

server.setRequestHandler(
  "tasks/update",
  { params: z.object({ taskId: z.string(), inputResponses: z.record(z.string(), z.unknown()).optional() }) },
  async ({ taskId, inputResponses: parsedInputResponses }, context) => {
    const inputResponses = parsedInputResponses ?? context.mcpReq?.inputResponses;
    const task = tasks.get(taskId);
    if (!task || task.status !== "input_required") throw new Error("Task is not waiting for input.");
    const approval = inputResponses.approval;
    if (approval?.action !== "accept" || approval?.content?.approved !== true) {
      throw new Error("Expected the approved input response.");
    }
    task.updates += 1;
    task.status = "working";
    task.lastUpdatedAt = new Date().toISOString();
    delete task.inputRequests;
    return UpdateTaskResultV2Schema.parse({ resultType: "complete" });
  },
);

server.setRequestHandler(
  "tasks/cancel",
  { params: z.object({ taskId: z.string() }) },
  async ({ taskId }) => {
    const task = tasks.get(taskId);
    if (!task) throw new Error("Unknown task.");
    task.status = "cancelled";
    task.lastUpdatedAt = new Date().toISOString();
    return CancelTaskResultV2Schema.parse({ resultType: "complete" });
  },
);

serveStdio(() => server, {
  onerror: (error) => process.stderr.write("[tasks-e2e-server] " + error.message + "\n"),
});