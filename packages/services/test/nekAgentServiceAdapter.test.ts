import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import type { NekGuiInfo, NekInteractionFrame, NekRpcCommand } from "@zcode/shared/nek-protocol";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import {
  NEK_INTERACTION_FEED_METHODS,
  createZCodeAgentConnectionScope,
} from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "../src/nek-agent/nekRpcClient.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import { createNekZCodeAgentService } from "../src/node.js";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";
import type { NekExtensionUiHandler } from "../src/nek-agent/nekExtensionUiRouter.js";

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

interface FakeProcess {
  process: NekRpcProcess;
  commands: NekRpcCommand[];
  /** nek 收到的 `extension_ui_response`：用来断言 GUI 的回答真的回到 nek 侧。 */
  responses: unknown[];
  /** 让某个 extension_call 方法按 nek 的格式失败，用于错误可见性断言。 */
  failExtensions: Set<string>;
  /** 让某个 extension_call 方法返回形状不对的结果（验证 host 不把脏数据交给界面）。 */
  invalidExtensions: Set<string>;
  /** 模拟 nek 主动发出的 stdout 事件（extension_ui_request / extension_ui_cancel）。 */
  emit(record: unknown): void;
}

function fakeProcess(
  kind: "control" | "session",
  options: {
    extensionUi?: NekExtensionUiHandler;
    projectTrust?: { trusted: boolean | null; defaultProjectTrust: "ask" | "always" | "never" };
    planCount?: number;
  } = {},
): FakeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const responses: unknown[] = [];
  const failExtensions = new Set<string>();
  const invalidExtensions = new Set<string>();
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
      if (command.type === "extension_ui_response") {
        responses.push(command);
        continue;
      }
      commands.push(command);
      if (!command.id) continue;
      let data: unknown = {};
      if (kind === "control") {
        if (command.type === "get_project_trust")
          data = {
            cwd: command.cwd,
            resources: [],
            ...(options.projectTrust ?? { trusted: true, defaultProjectTrust: "always" }),
          };
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
        if (failExtensions.has(command.method)) {
          stdout.write(
            `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: `nek rejected ${command.method}` })}\n`,
          );
          continue;
        }
        if (invalidExtensions.has(command.method)) data = { result: {} };
        else if (command.method === "nek.stop_subagent") data = { result: { status: "aborted" } };
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
        else if (command.method === "nek.get_plan") {
          const requested = (command.params as { path?: string } | undefined)?.path;
          const index = Number(requested?.match(/(\d+)\.plan\.md$/u)?.[1] ?? "1");
          data = {
            result: {
              path: requested ?? "/workspace/.nek/plans/1.plan.md",
              name: `Ship ${index}`,
              overview: "Ship the feature",
              revision: index,
              status: "ready",
              todos: [{ id: `todo-${index}`, content: "Implement" }],
              markdown: `# Ship ${index}`,
            },
          };
        } else if (command.method === "nek.get_state")
          data = {
            result: {
              mode: "agent",
              todos: [],
              plans: Array.from({ length: options.planCount ?? 1 }, (_, index) => ({
                path: `/workspace/.nek/plans/${index + 1}.plan.md`,
                name: `Ship ${index + 1}`,
                overview: "Ship the feature",
                revision: index + 1,
                status: "ready",
                todos: [{ id: `todo-${index + 1}`, content: "Implement" }],
              })),
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
  const client = new NekRpcClient(handle, {
    defaultTimeoutMs: 500,
    extensionUi: options.extensionUi,
  });
  const emitExit = (info: NekRpcProcessExit) => {
    if (exited) return;
    exited = true;
    for (const listener of exits) listener(info);
  };
  return {
    commands,
    responses,
    failExtensions,
    invalidExtensions,
    emit: (record) =>
      stdout.write(`${JSON.stringify(record)}
`),
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
  "stopSubagent",
  "getSubagentTranscript",
  "listAgentTypes",
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
  "onDynamicNekInteractionFrame",
  "respondNekInteraction",
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
    assert.equal(result.plans[0]?.output?.text, "# Ship 1");
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

test("publishes the project trust confirm through the interaction channel and stores it", async () => {
  const control = fakeProcess("control", {
    projectTrust: { trusted: null, defaultProjectTrust: "ask" },
  });
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) =>
      fakeProcess("session", request.extensionUi ? { extensionUi: request.extensionUi } : {})
        .process,
  });
  try {
    const target = { workspacePath: "/workspace" };
    const frames: NekInteractionFrame[] = [];
    const subscription = adapter.onDynamicNekInteractionFrame(target)((frame) =>
      frames.push(frame),
    );
    const pending = adapter.createNekSession(target);
    await waitForInteraction(() => frames.length > 0);
    const frame = frames[0];
    assert.equal(frame?.kind, "request");
    if (frame?.kind !== "request") throw new Error("expected a trust request frame");
    assert.equal(frame.request.method, "confirm");
    assert.match(frame.request.title, /信任此项目/u);
    await adapter.respondNekInteraction({
      requestId: frame.request.id,
      response: { type: "extension_ui_response", id: frame.request.id, confirmed: true },
    });
    const created = await pending;
    assert.equal(created.sessionId.length > 0, true);
    assert.deepEqual(
      control.commands.map((command) => command.type),
      ["get_project_trust", "set_project_trust"],
    );
    subscription.dispose();
  } finally {
    await adapter.dispose();
  }
});

test("hosts the interaction feed and subagent RPCs on the connection scope facade", async () => {
  const control = fakeProcess("control");
  const sessions: FakeProcess[] = [];
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    askProjectTrust: () => true,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      const created = fakeProcess(
        "session",
        request.extensionUi ? { extensionUi: request.extensionUi } : {},
      );
      sessions.push(created);
      return created.process;
    },
  });
  const scope = createZCodeAgentConnectionScope(adapter, {
    connectionId: "host-rpc-test",
    clientMode: "desktop-continuous",
  });
  try {
    for (const method of NEK_INTERACTION_FEED_METHODS) {
      assert.equal(typeof scope.service[method], "function", method);
    }

    const target = { workspacePath: "/workspace" };
    const frames: NekInteractionFrame[] = [];
    const subscription = scope.service.onDynamicNekInteractionFrame(target)((frame) =>
      frames.push(frame),
    );
    const created = await adapter.createNekSession(target);
    const session = sessions[0];
    if (!session) throw new Error("expected a session process");

    const answer = { answers: [{ questionId: "q1", selected: ["opt-a"] }] };
    session.emit({
      type: "extension_ui_request",
      id: "ask-1",
      method: "structured",
      kind: "nek.ask_question",
      payload: {
        title: "Pick a route",
        questions: [
          {
            id: "q1",
            prompt: "Which route?",
            options: [{ id: "opt-a", label: "Route A" }],
          },
        ],
      },
    });
    await waitForInteraction(() => frames.length > 0);
    const frame = frames[0];
    if (frame?.kind !== "request") throw new Error("expected an ask_question frame");
    assert.equal(frame.request.kind, "nek.ask_question");
    // 帧按会话 id 打标：publish 把 nek 的 sessionKey 映射成 renderer 用的 sessionId。
    assert.equal(frame.scope.sessionId, created.sessionId);
    assert.deepEqual(session.responses, []);

    await scope.service.respondNekInteraction({
      requestId: frame.request.id,
      response: { type: "extension_ui_response", id: frame.request.id, result: answer },
    });
    await waitForInteraction(() => session.responses.length > 0);
    assert.deepEqual(session.responses[0], {
      type: "extension_ui_response",
      id: "ask-1",
      result: answer,
    });
    assert.equal(
      frames.some((candidate) => candidate.kind === "cancel"),
      false,
    );

    const sessionTarget = { ...target, sessionId: created.sessionId };
    assert.deepEqual(await scope.service.stopSubagent({ ...sessionTarget, id: "child-1" }), {
      status: "aborted",
    });
    assert.deepEqual(
      await scope.service.getSubagentTranscript({ ...sessionTarget, id: "child-1" }),
      {
        messages: [{ role: "assistant", content: "done" }],
      },
    );
    const types = await scope.service.listAgentTypes(sessionTarget);
    assert.equal(types.types[0]?.name, "worker");
    subscription.dispose();

    await scope.dispose();
    assert.throws(
      () => scope.service.onDynamicNekInteractionFrame(target),
      /fault\.connection\.closed/u,
    );
    await assert.rejects(
      scope.service.stopSubagent({ ...sessionTarget, id: "child-1" }),
      /fault\.connection\.closed/u,
    );
  } finally {
    await scope.dispose();
    await adapter.dispose();
  }
});

test("surfaces subagent RPC failures and closed-session errors", async () => {
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
    session.failExtensions.add("nek.stop_subagent");
    await assert.rejects(
      adapter.stopSubagent({ ...target, sessionId: created.sessionId, id: "child-1" }),
      /nek rejected nek\.stop_subagent/u,
    );
    await assert.rejects(
      adapter.getSubagentTranscript({ ...target, sessionId: "missing", id: "child-1" }),
      /nek session missing is not open/u,
    );
    session.invalidExtensions.add("nek.list_agent_types");
    await assert.rejects(
      adapter.listAgentTypes({ ...target, sessionId: created.sessionId }),
      /invalid agent type list/u,
    );
    session.invalidExtensions.add("nek.get_subagent_transcript");
    await assert.rejects(
      adapter.getSubagentTranscript({ ...target, sessionId: created.sessionId, id: "child-1" }),
      /invalid subagent transcript/u,
    );
    await assert.rejects(
      adapter.respondNekInteraction({
        requestId: "gone",
        response: { type: "extension_ui_response", id: "gone", cancelled: true },
      }),
      /is no longer pending/u,
    );
  } finally {
    await adapter.dispose();
  }
});

async function waitForInteraction(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for an interaction frame");
}

test("bounds the conversation plan list with the GUI runtime config", async () => {
  const control = fakeProcess("control");
  const session = fakeProcess("session", { planCount: 3 });
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    askProjectTrust: () => true,
    createControlProcess: () => control.process,
    createSessionProcess: () => session.process,
    runtimeConfig: {
      ...DEFAULT_GUI_RUNTIME_CONFIG,
      nek: { ...DEFAULT_GUI_RUNTIME_CONFIG.nek, maxConversationPlans: 2 },
    },
  });
  try {
    const target = { workspacePath: "/workspace" };
    const created = await adapter.createNekSession(target);
    const result = await adapter.conversationPlansV4({ ...target, sessionId: created.sessionId });
    assert.deepEqual(
      result.plans.map((plan) => plan.toolCallId),
      ["/workspace/.nek/plans/3.plan.md", "/workspace/.nek/plans/2.plan.md"],
    );
    assert.equal(
      session.commands.filter(
        (command) => command.type === "extension_call" && command.method === "nek.get_plan",
      ).length,
      2,
    );
  } finally {
    await adapter.dispose();
  }
});
