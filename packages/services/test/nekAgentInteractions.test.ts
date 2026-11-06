import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { NekGuiInfo, NekInteractionFrame, NekRpcCommand } from "@zcode/shared/nek-protocol";
import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "../src/nek-agent/nekRpcClient.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import { NekAgentInteractionChannel } from "../src/nek-agent/adapter/nekAgentInteractionChannel.js";
import { NekAgentService } from "../src/nek-agent/service/nekAgentService.js";
import type { NekExtensionUiHandler } from "../src/nek-agent/nekExtensionUiRouter.js";
import type { NekAgentServiceOptions } from "../src/nek-agent/service/types.js";

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
  responses: unknown[];
  /** 模拟 nek 主动发出的 stdout 事件（extension_ui_request / extension_ui_cancel）。 */
  emit(record: unknown): void;
}

function fakeProcess(
  kind: "control" | "session",
  extensionUi?: NekExtensionUiHandler,
  projectTrust: { trusted: boolean | null; defaultProjectTrust: "ask" | "always" | "never" } = {
    trusted: null,
    defaultProjectTrust: "ask",
  },
): FakeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const responses: unknown[] = [];
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
        if (command.type === "get_project_trust") {
          data = { cwd: command.cwd, resources: [], ...projectTrust };
        } else if (command.type === "list_sessions") {
          data = { sessions: [] };
        }
      } else if (command.type === "get_state") {
        data = {
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionFile: "/tmp/session.jsonl",
          sessionId: "s1",
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
        data = { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
      }
      stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data })}\n`,
      );
    }
  });
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
  const client = new NekRpcClient(handle, { defaultTimeoutMs: 500, extensionUi });
  const emitExit = (info: NekRpcProcessExit) => {
    for (const listener of exits) listener(info);
    exits.clear();
  };
  return {
    commands,
    responses,
    emit: (record) => stdout.write(`${JSON.stringify(record)}\n`),
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

function harness(overrides: Partial<NekAgentServiceOptions> = {}) {
  const control = fakeProcess("control");
  const sessions: FakeProcess[] = [];
  const service = new NekAgentService({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      const session = fakeProcess("session", request.extensionUi);
      sessions.push(session);
      return session.process;
    },
    ...overrides,
  });
  const frames: NekInteractionFrame[] = [];
  service.onInteractionEvent((frame) => frames.push(frame));
  return { control, sessions, service, frames };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${message}`);
}

test("publishes the project trust confirm on the GUI channel and records the decision", async () => {
  const { control, service, frames } = harness();
  try {
    const pending = service.createSession({ cwd: "/workspace" });
    await waitFor(() => frames.length > 0, "the trust confirm request");
    const frame = frames[0];
    assert.ok(frame);
    assert.equal(frame.kind, "request");
    if (frame.kind !== "request") throw new Error("unreachable");
    assert.equal(frame.request.method, "confirm");
    assert.deepEqual(frame.scope, { workspacePath: "/workspace" });
    await service.respondInteraction({
      type: "extension_ui_response",
      id: frame.request.id,
      confirmed: true,
    });
    const created = await pending;
    assert.equal(created.readonly, false);
    assert.deepEqual(
      control.commands.map((command) => command.type),
      ["get_project_trust", "set_project_trust"],
    );
  } finally {
    await service.dispose();
  }
});

test("a rejected trust prompt fails visibly and a later retry can be approved", async () => {
  const { control, service, frames } = harness();
  try {
    const pending = service.createSession({ cwd: "/workspace" });
    await waitFor(() => frames.length > 0, "the trust confirm request");
    const frame = frames[0];
    if (frame?.kind !== "request") throw new Error("expected a trust request frame");
    await service.respondInteraction({
      type: "extension_ui_response",
      id: frame.request.id,
      confirmed: false,
    });
    await assert.rejects(pending, /project trust denied for \/workspace; confirm trust and retry/u);
    assert.deepEqual(
      control.commands.map((command) => command.type),
      ["get_project_trust"],
    );

    const retry = service.createSession({ cwd: "/workspace" });
    await waitFor(() => frames.length > 1, "the retried trust confirm request");
    const second = frames[1];
    if (second?.kind !== "request") throw new Error("expected a trust request frame");
    await service.respondInteraction({
      type: "extension_ui_response",
      id: second.request.id,
      confirmed: true,
    });
    assert.equal((await retry).readonly, false);
    assert.deepEqual(
      control.commands.map((command) => command.type),
      ["get_project_trust", "get_project_trust", "set_project_trust"],
    );
  } finally {
    await service.dispose();
  }
});

test("an unanswered interaction is cancelled on timeout instead of hanging nek", async () => {
  const { service, frames } = harness({
    runtimeConfig: {
      ...DEFAULT_GUI_RUNTIME_CONFIG,
      timeouts: { ...DEFAULT_GUI_RUNTIME_CONFIG.timeouts, interactionMs: 5 },
    },
  });
  try {
    await assert.rejects(
      service.createSession({ cwd: "/workspace" }),
      /project trust denied for \/workspace/u,
    );
    assert.equal(frames[0]?.kind, "request");
    assert.ok(
      frames.some((frame) => frame.kind === "cancel"),
      "timeout must publish a cancel frame so the GUI closes the card",
    );
  } finally {
    await service.dispose();
  }
});

test("P2: leaving and returning to a workspace preserves and replays pending approval", async () => {
  const control = fakeProcess("control");
  const sessions: FakeProcess[] = [];
  const service = new NekAgentService({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      const session = fakeProcess("session", request.extensionUi);
      sessions.push(session);
      return session.process;
    },
  });
  const channel = new NekAgentInteractionChannel(service);
  const frames: NekInteractionFrame[] = [];
  try {
    const first = channel.onDynamic({ workspacePath: "/workspace" })((frame) => frames.push(frame));
    const second = channel.onDynamic({ workspacePath: "/workspace" })(() => undefined);
    const pending = service.createSession({ cwd: "/workspace" });
    await waitFor(() => frames.some((frame) => frame.kind === "request"), "the trust request");

    // 还有一个 renderer 订阅者：请求必须继续等回答，不能被提前取消。
    first.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      frames.some((frame) => frame.kind === "cancel"),
      false,
      "one remaining subscriber must keep the request pending",
    );

    // 离开界面不是拒绝；返回后重放同一 request，直到用户真正作出决定。
    second.dispose();
    assert.equal(service.pendingInteractions("/workspace").length, 1);
    const replay: NekInteractionFrame[] = [];
    const returned = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
      replay.push(frame),
    );
    assert.equal(replay.length, 1);
    const request = replay[0];
    if (request?.kind !== "request") throw new Error("expected replayed approval");
    await channel.respond({
      type: "extension_ui_response",
      id: request.request.id,
      confirmed: true,
    });
    assert.equal((await pending).readonly, false);
    assert.equal(service.pendingInteractions("/workspace").length, 0);
    returned.dispose();
    assert.deepEqual(
      control.commands.map((command) => command.type),
      ["get_project_trust", "set_project_trust"],
    );
  } finally {
    channel.dispose();
    await service.dispose();
  }
});

test("P2/P3: structured mode and plan approvals survive identity-scoped reconnects", async () => {
  const { service, sessions } = harness({ askProjectTrust: () => true });
  const channel = new NekAgentInteractionChannel(service);
  const target = { workspacePath: "/workspace", workspaceIdentity: "local-workspace" };
  const other: NekInteractionFrame[] = [];
  const unrelated = channel.onDynamic({ workspacePath: "/other" })((frame) => other.push(frame));
  try {
    const created = await service.createSession({ cwd: target.workspacePath });
    const session = sessions[0]!;
    for (const kind of ["nek.switch_mode", "nek.plan_review"]) {
      const id = `approval-${kind}`;
      const frames: NekInteractionFrame[] = [];
      const listener = channel.onDynamic(target)((frame) => frames.push(frame));
      session.emit({ type: "extension_ui_request", id, method: "structured", kind, payload: {} });
      await waitFor(() => frames.length === 1, "identity-scoped approval");
      assert.equal(frames[0]?.scope.sessionId, created.sessionId);
      listener.dispose();
      assert.equal(session.responses.length, kind === "nek.switch_mode" ? 0 : 1);
      const replay: NekInteractionFrame[] = [];
      const returned = channel.onDynamic(target)((frame) => replay.push(frame));
      assert.equal(replay.length, 1);
      const result = kind === "nek.switch_mode" ? { approved: true } : { action: "implement" };
      await channel.respond({ type: "extension_ui_response", id, result });
      await waitFor(
        () => session.responses.length === (kind === "nek.switch_mode" ? 1 : 2),
        "nek approval response",
      );
      assert.deepEqual(session.responses.at(-1), { type: "extension_ui_response", id, result });
      returned.dispose();
    }
    assert.equal(other.length, 0);
  } finally {
    unrelated.dispose();
    channel.dispose();
    await service.dispose();
  }
});

test("cancelling a workspace answers every pending interaction as cancelled", async () => {
  const { service, frames } = harness();
  try {
    const pending = service.createSession({ cwd: "/workspace" });
    await waitFor(() => frames.some((frame) => frame.kind === "request"), "the trust request");
    service.cancelWorkspaceInteractions("/workspace");
    await assert.rejects(pending, /project trust denied for \/workspace/u);
    assert.ok(
      frames.some((frame) => frame.kind === "cancel"),
      "workspace cancellation must publish a cancel frame",
    );
  } finally {
    await service.dispose();
  }
});

test("nek cancelling a session dialog publishes a cancel frame and answers nek", async () => {
  const { sessions, service, frames } = harness({ askProjectTrust: () => true });
  try {
    const created = await service.createSession({ cwd: "/workspace" });
    const session = sessions[0];
    if (!session) throw new Error("expected a session process");
    session.emit({
      type: "extension_ui_request",
      id: "ask-1",
      method: "input",
      title: "Which file?",
    });
    await waitFor(() => frames.length > 0, "the session dialog request");
    const frame = frames[0];
    assert.equal(frame?.kind, "request");
    assert.equal(frame?.scope.sessionKey, created.sessionKey);

    session.emit({ type: "extension_ui_cancel", id: "ask-1" });
    await waitFor(
      () => frames.some((candidate) => candidate.kind === "cancel"),
      "the cancel frame",
    );
    assert.equal(
      service.respondInteraction({
        type: "extension_ui_response",
        id: "ask-1",
        cancelled: true,
      }),
      false,
    );
  } finally {
    await service.dispose();
  }
});

test("an unattached renderer channel is a wiring error, but recorded trust still opens", async () => {
  const askControl = fakeProcess("control");
  const untrusted = new NekAgentService({
    guiInfo,
    createControlProcess: () => askControl.process,
    createSessionProcess: (request) => fakeProcess("session", request.extensionUi).process,
  });
  try {
    await assert.rejects(
      untrusted.createSession({ cwd: "/workspace" }),
      /no renderer is subscribed to the nek interaction channel/u,
    );
  } finally {
    await untrusted.dispose();
  }

  // 已经记录过的信任不需要询问，也不该因为渲染层没订阅而失败。
  const trustedControl = fakeProcess("control", undefined, {
    trusted: true,
    defaultProjectTrust: "ask",
  });
  const trusted = new NekAgentService({
    guiInfo,
    createControlProcess: () => trustedControl.process,
    createSessionProcess: (request) => fakeProcess("session", request.extensionUi).process,
  });
  try {
    const created = await trusted.createSession({ cwd: "/workspace" });
    assert.equal(created.readonly, false);
    assert.deepEqual(
      trustedControl.commands.map((command) => command.type),
      ["get_project_trust"],
    );
  } finally {
    await trusted.dispose();
  }
});
