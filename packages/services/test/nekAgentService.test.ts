import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { NekGuiInfo, NekRpcCommand, NekSessionSnapshot } from "@zcode/shared/nek-protocol";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "../src/nek-agent/nekRpcClient.js";
import type { NekExtensionUiHandler } from "../src/nek-agent/nekExtensionUiRouter.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import { NekAgentService } from "../src/nek-agent/service/nekAgentService.js";

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

const stats = {
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

function state(sessionFile = "/tmp/session.jsonl", streaming = false) {
  return {
    model: undefined,
    thinkingLevel: "medium" as const,
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: "all" as const,
    followUpMode: "one-at-a-time" as const,
    sessionFile,
    sessionId: "s1",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

function snapshot(locked: boolean): NekSessionSnapshot {
  return {
    session: {
      path: "/tmp/session.jsonl",
      id: "s1",
      cwd: "/workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      firstMessage: "",
      locked,
    },
    entries: [],
    leafId: null,
    messages: [],
  };
}

interface FakeProcess {
  process: NekRpcProcess;
  commands: NekRpcCommand[];
  emit(record: unknown): void;
  exit(info?: Partial<NekRpcProcessExit>): void;
}

function fakeProcess(
  kind: "control" | "session",
  sessionFile = "/tmp/session.jsonl",
  extensionUi?: NekExtensionUiHandler,
): FakeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const exits = new Set<(info: NekRpcProcessExit) => void>();
  let exited = false;
  let streaming = false;
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    while (true) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const command = JSON.parse(line) as NekRpcCommand & { id?: string };
      if (command.type === "extension_ui_response") continue;
      commands.push(command);
      if (!command.id) continue;
      let data: unknown;
      if (kind === "control") {
        if (command.type === "get_project_trust") {
          data = { cwd: command.cwd, trusted: null, defaultProjectTrust: "ask", resources: [] };
        } else if (command.type === "read_session_snapshot") {
          data = snapshot(true);
        } else if (command.type === "list_sessions") {
          data = { sessions: [] };
        } else if (command.type === "get_mention_targets") {
          data = { targets: [] };
        } else {
          data = {};
        }
      } else if (command.type === "get_state") {
        data = state(sessionFile, streaming);
      } else if (command.type === "get_entries") {
        data = { entries: [], leafId: null };
      } else if (command.type === "get_session_stats") {
        data = { ...stats, sessionFile, sessionId: "s1" };
      } else if (command.type === "extension_call") {
        data = { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
      } else if (command.type === "prompt") {
        streaming = true;
        data = { disposition: "started" };
      } else if (command.type === "steer" || command.type === "follow_up") {
        data = { disposition: "queued" };
      } else if (command.type === "bash") {
        data = { output: "ok", exitCode: 0, cancelled: false, truncated: false };
      } else if (command.type === "clear_queue") {
        data = { steering: ["steer me"], followUp: ["later"] };
      } else {
        data = {};
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
    if (exited) return;
    exited = true;
    for (const listener of exits) listener(info);
  };
  return {
    process: {
      client,
      guiInfo,
      pid: 42,
      exitInfo: () => undefined,
      onExit: (listener) => handle.onExit(() => listener()),
      dispose: async () => {
        if (!exited) emitExit({ code: 0, signal: null });
        await client.close();
      },
    },
    commands,
    emit: (record) => stdout.write(`${JSON.stringify(record)}\n`),
    exit: (info = {}) => emitExit({ code: info.code ?? 1, signal: info.signal ?? null, ...info }),
  };
}

function serviceHarness(extensionUi?: NekExtensionUiHandler) {
  const control = fakeProcess("control");
  const sessions: FakeProcess[] = [];
  const approvals: boolean[] = [];
  const service = new NekAgentService({
    guiInfo,
    askProjectTrust: () => true,
    extensionUi,
    createControlProcess: () => control.process,
    createSessionProcess: (options) => {
      approvals.push(options.approve === true);
      const process = fakeProcess(
        "session",
        options.sessionPath ?? "/tmp/session.jsonl",
        options.extensionUi,
      );
      sessions.push(process);
      return process.process;
    },
  });
  return { service, control, sessions, approvals };
}

test("creates a session after project trust approval and passes --approve", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  assert.equal(result.sessionId, "s1");
  assert.equal(result.readonly, false);
  assert.deepEqual(harness.approvals, [true]);
  assert.deepEqual(harness.control.commands.map((command) => command.type), ["get_project_trust"]);
  await harness.service.dispose();
});

test("opens a locked session from a read-only snapshot", async () => {
  const harness = serviceHarness();
  const result = await harness.service.resumeSession({ sessionPath: "/tmp/session.jsonl" });
  assert.equal(result.readonly, true);
  assert.equal(result.phase, "locked");
  assert.equal(result.lockedBy, "nek");
  assert.equal(harness.sessions.length, 0);
  await harness.service.dispose();
});

test("chooses prompt while idle and steer/follow_up while running, then aborts", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  const key = result.sessionKey;
  await harness.service.sendPrompt({ sessionKey: key, message: "hello" });
  harness.sessions[0]!.emit({ type: "agent_start" });
  await harness.service.sendPrompt({ sessionKey: key, message: "now", streamingBehavior: "steer" });
  await harness.service.sendPrompt({ sessionKey: key, message: "later", streamingBehavior: "followUp" });
  await harness.service.abort(key);
  assert.deepEqual(
    harness.sessions[0]!.commands.map((command) => command.type),
    ["get_state", "get_state", "get_entries", "get_session_stats", "extension_call", "prompt", "steer", "follow_up", "abort"],
  );
  await harness.service.dispose();
});

test("shares one projector for subscribers and replays a snapshot on resubscribe", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  const first: unknown[] = [];
  const second: unknown[] = [];
  await harness.service.subscribeConversation(result.sessionKey, (frame) => first.push(frame));
  await harness.service.subscribeConversation(result.sessionKey, (frame) => second.push(frame));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  harness.sessions[0]!.emit({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(first.length >= 2);
  assert.ok(second.length >= 2);
  const third: unknown[] = [];
  await harness.service.subscribeConversation(result.sessionKey, (frame) => third.push(frame));
  assert.equal(third.length, 1);
  assert.equal((third[0] as { payload: { kind: string } }).payload.kind, "snapshot");
  await harness.service.dispose();
});

test("enters error on an unexpected exit and can restart", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  harness.sessions[0]!.exit({ code: 2 });
  assert.equal(harness.service.getSession(result.sessionKey)?.phase, "error");
  const restarted = await harness.service.restartSession(result.sessionKey);
  assert.equal(restarted.phase, "idle");
  assert.equal(harness.sessions.length, 2);
  await harness.service.dispose();
});

test("routes structured UI and cancels it through the injected router", async () => {
  let cancelled = false;
  const harness = serviceHarness({
    structured: (_request, signal) =>
      new Promise<undefined>((resolve) => {
        signal.addEventListener("abort", () => {
          cancelled = true;
          resolve(undefined);
        });
      }),
  });
  const result = await harness.service.createSession({ cwd: "/workspace" });
  harness.sessions[0]!.emit({
    type: "extension_ui_request",
    id: "structured-1",
    method: "structured",
    kind: "nek.ask_question",
    payload: { questions: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  harness.sessions[0]!.emit({ type: "extension_ui_cancel", id: "structured-1" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelled, true);
  await harness.service.closeSession(result.sessionKey);
});
