import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { NekGuiInfo, NekRpcCommand } from "@zcode/shared/nek-protocol";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "../src/nek-agent/nekRpcClient.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import { createNekZCodeAgentService } from "../src/node.js";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";

const guiInfo = {
  protocolVersion: 1,
  nekVersion: "test",
  piVersion: "test",
  node: { path: process.execPath, version: process.versions.node },
  launch: { args: [] },
  agentDir: "/tmp/agent",
  sessionDir: "/tmp/sessions",
  platform: "linux",
  arch: "x64",
} satisfies NekGuiInfo;

function fakeProcess(kind: "control" | "session"): {
  process: NekRpcProcess;
  commands: NekRpcCommand[];
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const exits = new Set<(info: NekRpcProcessExit) => void>();
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    for (;;) {
      const index = input.indexOf("\n");
      if (index < 0) break;
      const line = input.slice(0, index);
      input = input.slice(index + 1);
      if (!line) continue;
      const command = JSON.parse(line) as NekRpcCommand & { id?: string };
      if (command.type === "extension_ui_response") continue;
      commands.push(command);
      if (!command.id) continue;
      let data: unknown = {};
      if (kind === "control") {
        if (command.type === "get_project_trust")
          data = { cwd: command.cwd, trusted: true, defaultProjectTrust: "always", resources: [] };
        if (command.type === "list_sessions") data = { sessions: [] };
        if (command.type === "get_available_models") data = { models: [] };
      } else if (command.type === "get_state") {
        data = {
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionFile: "/tmp/session.jsonl",
          sessionId: "s1",
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      } else if (command.type === "get_entries") {
        data = { entries: [], leafId: null };
      } else if (command.type === "get_session_stats") {
        data = {
          sessionFile: "/tmp/session.jsonl",
          sessionId: "s1",
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        };
      } else if (command.type === "extension_call") {
        if (command.method === "nek.stop_subagent") data = { result: { status: "aborted" } };
        else if (command.method === "nek.get_subagent_transcript")
          data = { result: { messages: [{ role: "assistant", content: "done" }] } };
        else if (command.method === "nek.list_agent_types")
          data = {
            result: {
              types: [
                {
                  name: "worker",
                  description: "Worker",
                  source: "builtin",
                  readonly: true,
                  background: true,
                  autonomous: false,
                },
              ],
            },
          };
        else if (command.method === "nek.get_plan")
          data = {
            result: {
              path: "/workspace/.nek/plans/ship.plan.md",
              name: "Ship",
              overview: "Ship the feature",
              revision: 2,
              status: "ready",
              todos: [{ id: "todo-1", content: "Implement" }],
              markdown: "# Ship\n\n- Implement",
            },
          };
        else if (command.method === "nek.get_state")
          data = {
            result: {
              mode: "agent",
              todos: [],
              plans: [
                {
                  path: "/workspace/.nek/plans/ship.plan.md",
                  name: "Ship",
                  overview: "Ship the feature",
                  revision: 2,
                  status: "ready",
                  todos: [{ id: "todo-1", content: "Implement" }],
                },
              ],
              subagents: [],
            },
          };
        else data = { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
      } else if (command.type === "get_available_models") {
        data = { models: [] };
      } else if (command.type === "get_commands") {
        data = { commands: [] };
      } else if (command.type === "prompt") {
        data = { disposition: "started" };
      }
      stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data })}\n`,
      );
    }
  });
  let exited = false;
  const handle: NekRpcProcessHandle = {
    stdin,
    stdout,
    stderr,
    kill: () => emitExit({ code: null, signal: "SIGKILL" }),
    onExit: (listener) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
  };
  const client = new NekRpcClient(handle, { defaultTimeoutMs: 500 });
  const emitExit = (info: NekRpcProcessExit) => {
    if (exited) return;
    exited = true;
    for (const listener of exits) listener(info);
  };
  return {
    commands,
    process: {
      client,
      guiInfo,
      pid: undefined,
      exitInfo: () => undefined,
      onExit: (listener) => handle.onExit(() => listener()),
      dispose: async () => {
        emitExit({ code: 0, signal: null });
        await client.close();
      },
    },
  };
}

test("maps a nek session to v4 conversation and rejects non-image attachments", async () => {
  const control = fakeProcess("control");
  const session = fakeProcess("session");
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    askProjectTrust: () => true,
    createControlProcess: () => control.process,
    createSessionProcess: () => session.process,
  });
  try {
    const target = { workspacePath: "/workspace" };
    const created = await adapter.createNekSession(target);
    const frames: unknown[] = [];
    const event = adapter.onDynamicConversationFrame(target);
    const disposable = event((frame) => frames.push(frame));
    const subscription = await adapter.subscribeConversationV4({
      ...target,
      sessionId: created.sessionId,
    });
    assert.equal(subscription.ack.mode, "snapshot");
    assert.equal(frames.length, 1);
    await assert.rejects(
      adapter.sendNekConversationCommandV4({
        target,
        envelope: {
          commandId: "cmd-1",
          clientId: "test",
          sessionId: created.sessionId,
          type: "sendText",
          payload: { text: "hello", attachments: [{ mime: "text/plain", ref: "/tmp/a.txt" }] },
          issuedAt: Date.now(),
        },
      }),
      /仅支持图片/u,
    );
    await adapter.unsubscribeConversationV4({
      ...target,
      subscriptionId: subscription.ack.subscriptionId,
    });
    disposable.dispose();
  } finally {
    await adapter.dispose();
  }
  assert.ok(session.commands.some((command) => command.type === "get_entries"));
});

const IZCODE_METHODS = [
  "prepareStorage",
  "getStorageStartupState",
  "onDynamicStorageStartupState",
  "initialize",
  "syncAppRuntimePreferences",
  "getWorkspaceRuntimeIdentity",
  "createSession",
  "resumeSession",
  "listSessions",
  "listSessionSubagents",
  "getTaskTokenUsage",
  "readSession",
  "readSessionMessages",
  "readSessionDebug",
  "readSessionEvents",
  "readWorkspacePresentation",
  "grantWorkspaceHookTrust",
  "listMcpServerStatuses",
  "getSkillReferenceCatalog",
  "collectLocalRuntimeChildProcesses",
  "generateWorkspaceText",
  "testModelConnectivity",
  "sendPrompt",
  "compactSession",
  "goalSession",
  "closeSession",
  "setModel",
  "setThoughtLevel",
  "setMode",
  "respondSessionRuntimePreferences",
  "onDynamicSessionRuntimePreferencesRequest",
  "onDynamicProcessResourceSample",
  "onDynamicMcpTelemetry",
  "onDynamicMcpResourceSamples",
  "onDynamicToolExecResource",
  "onDynamicSessionEvent",
  "helloConversationV4",
  "initializeConversationV4",
  "setConnectionFlowStateV4",
  "subscribeConversationV4",
  "resyncConversationV4",
  "unsubscribeConversationV4",
  "conversationRowsRangeV4",
  "conversationPlansV4",
  "backgroundBashOutputV4",
  "conversationFileChangesV4",
  "conversationFileRewindPreviewV4",
  "sendConversationCommandV4",
  "queryConversationCommandsV4",
  "attachmentBeginV4",
  "attachmentChunkV4",
  "attachmentCommitV4",
  "attachmentAbortV4",
  "attachmentPreviewSourceV4",
  "attachmentReadV4",
  "conversationAttachmentReadV4",
  "conversationAttachmentStatV4",
  "onDynamicConversationFrame",
  "onDynamicDiagnostic",
  "onDynamicSessionActivity",
  "onDynamicLocalTtftFacts",
  "onDynamicConversationTelemetryFact",
  "subscribeSessionsIndexV4",
  "resyncSessionsIndexV4",
  "unsubscribeSessionsIndexV4",
  "onDynamicSessionsIndexFrame",
  "subscribeWorkspaceConfigV4",
  "resyncWorkspaceConfigV4",
  "unsubscribeWorkspaceConfigV4",
  "onDynamicWorkspaceConfigFrame",
  "onAgentRuntimeRestarted",
  "disposeWorkspace",
  "disposeAll",
] as const satisfies readonly (keyof IZCodeAgentService)[];

test("maps nek plan snapshots into the v4 plan result", async () => {
  const control = fakeProcess("control");
  const session = fakeProcess("session");
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    askProjectTrust: () => true,
    createControlProcess: () => control.process,
    createSessionProcess: () => session.process,
  });
  try {
    const target = { workspacePath: "/workspace" };
    const created = await adapter.createNekSession(target);
    const result = await adapter.conversationPlansV4({
      ...target,
      sessionId: created.sessionId,
    });
    assert.equal(result.plans.length, 1);
    assert.equal(result.plans[0]?.toolName, "nek.plan");
    assert.equal(result.plans[0]?.output?.text, "# Ship\n\n- Implement");
    assert.ok(result.atSeq >= 0);
    assert.ok(
      session.commands.some(
        (command) => command.type === "extension_call" && command.method === "nek.get_plan",
      ),
    );
  } finally {
    await adapter.dispose();
  }
});

test("routes subagent stop, transcript, and agent type RPCs through the adapter", async () => {
  const control = fakeProcess("control");
  const session = fakeProcess("session");
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    askProjectTrust: () => true,
    createControlProcess: () => control.process,
    createSessionProcess: () => session.process,
  });
  try {
    const target = { workspacePath: "/workspace" };
    const created = await adapter.createNekSession(target);
    assert.deepEqual(
      await adapter.stopSubagent({ ...target, sessionId: created.sessionId, id: "child-1" }),
      { status: "aborted" },
    );
    assert.deepEqual(
      await adapter.getSubagentTranscript({
        ...target,
        sessionId: created.sessionId,
        id: "child-1",
      }),
      { messages: [{ role: "assistant", content: "done" }] },
    );
    assert.deepEqual(await adapter.listAgentTypes({ ...target, sessionId: created.sessionId }), {
      types: [
        {
          name: "worker",
          description: "Worker",
          source: "builtin",
          readonly: true,
          background: true,
          autonomous: false,
        },
      ],
    });
    assert.deepEqual(
      session.commands
        .filter((command) => command.type === "extension_call")
        .map((command) => command.method),
      ["nek.get_state", "nek.stop_subagent", "nek.get_subagent_transcript", "nek.list_agent_types"],
    );
  } finally {
    await adapter.dispose();
  }
});

test("node factory returns an IZCodeAgentService with every method", () => {
  const control = fakeProcess("control");
  const session = fakeProcess("session");
  const service: IZCodeAgentService = createNekZCodeAgentService({
    guiInfo,
    askProjectTrust: () => true,
    createControlProcess: () => control.process,
    createSessionProcess: () => session.process,
  });
  for (const method of IZCODE_METHODS) assert.equal(typeof service[method], "function", method);
  service.disposeAll();
});
