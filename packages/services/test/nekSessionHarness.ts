/**
 * 磁盘会话恢复相关测试的共享替身：真实 adapter / service / 进程池 / 投影器，
 * 只把 nek 进程换成内存 JSONL 传输。
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { NekGuiInfo, NekRpcCommand, NekSessionSnapshot } from "@zcode/shared/nek-protocol";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";
import { NekRpcClient, type NekRpcProcessExit } from "../src/nek-agent/nekRpcClient.js";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";

export const target = { workspacePath: "/project" };
export const sessionId = "disk-session";
export const sessionPath = "/sessions/disk.jsonl";
const guiInfo: NekGuiInfo = {
  protocolVersion: 1,
  nekVersion: "test",
  piVersion: "test",
  node: { path: process.execPath, version: process.versions.node },
  launch: { args: [] },
  agentDir: "/isolated-agent",
  sessionDir: "/sessions",
  platform: "linux",
  arch: "x64",
};
export const entry = {
  id: "user-1",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "message" as const,
  message: { role: "user" as const, content: "saved prompt", timestamp: 1 },
};
const summary = {
  id: sessionId,
  path: sessionPath,
  cwd: target.workspacePath,
  createdAt: entry.timestamp,
  modifiedAt: entry.timestamp,
  messageCount: 1,
  firstMessage: "saved prompt",
  locked: false,
};

/** In-memory JSONL transport; the real adapter, service, pool and projector remain in the test. */
function createProcess(reply: (command: NekRpcCommand) => unknown | Promise<unknown>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const exits = new Set<(exit: NekRpcProcessExit) => void>();
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const command = JSON.parse(line) as NekRpcCommand & { id?: string };
      commands.push(command);
      if (!command.id) continue;
      void Promise.resolve()
        .then(() => reply(command))
        .then(
          (data) =>
            stdout.write(
              `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })}\n`,
            ),
          (error: unknown) =>
            stdout.write(
              `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: error instanceof Error ? error.message : String(error) })}\n`,
            ),
        );
    }
  });
  const handle = {
    stdin,
    stdout,
    stderr,
    onExit: (listener: (exit: NekRpcProcessExit) => void) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    kill: () => {
      for (const listener of exits) listener({ code: 0, signal: null });
    },
  };
  const client = new NekRpcClient(handle, { defaultTimeoutMs: 1_000 });
  const process: NekRpcProcess = {
    client,
    guiInfo,
    exitInfo: () => undefined,
    onExit: (listener) => handle.onExit(listener),
    dispose: async () => {
      handle.kill();
      await client.close();
    },
  };
  /** 模拟 nek 主动推送的 RPC 事件（JSONL 一行）。 */
  const emit = (record: Record<string, unknown>) => stdout.write(`${JSON.stringify(record)}\n`);
  return { process, commands, emit };
}

export function harness(
  options: { lockedBy?: NekSessionSnapshot["lockedBy"]; failEntries?: boolean } = {},
) {
  let failEntries = options.failEntries ?? false;
  let snapshotFailure: Error | undefined;
  let release: (() => void) | undefined;
  let barrier: Promise<void> | undefined;
  const snapshot: NekSessionSnapshot = {
    session: { ...summary, locked: !!options.lockedBy },
    lockedBy: options.lockedBy,
    entries: [entry],
    messages: [entry.message],
    leafId: entry.id,
  };
  const control = createProcess(async (command) => {
    if (command.type === "list_sessions") return { sessions: [snapshot.session] };
    if (command.type === "read_session_snapshot") {
      await barrier;
      if (snapshotFailure) throw snapshotFailure;
      return snapshot;
    }
    if (command.type === "get_project_trust")
      return {
        cwd: target.workspacePath,
        trusted: true,
        defaultProjectTrust: "always",
        resources: [],
      };
    return {};
  });
  const sessions: ReturnType<typeof createProcess>[] = [];
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      assert.equal(request.sessionPath, sessionPath);
      const session = createProcess((command) => {
        if (command.type === "get_state")
          return {
            sessionId,
            sessionFile: sessionPath,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: true,
            messageCount: 1,
            pendingMessageCount: 0,
          };
        if (command.type === "get_entries") {
          if (failEntries) {
            failEntries = false;
            throw new Error("entries load failed");
          }
          return { entries: [entry], leafId: entry.id };
        }
        if (command.type === "get_session_stats")
          return {
            sessionId,
            sessionFile: sessionPath,
            userMessages: 1,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 1,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
          };
        if (command.type === "extension_call")
          return { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
        if (command.type === "prompt") return { disposition: "started" };
        return {};
      });
      sessions.push(session);
      return session.process;
    },
  });
  return {
    adapter,
    sessions,
    control,
    failSnapshot: (error?: Error) => {
      snapshotFailure = error;
    },
    holdSnapshot: () => {
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseSnapshot: () => release?.(),
    releaseLock: () => {
      snapshot.session.locked = false;
      delete snapshot.lockedBy;
    },
  };
}

export const params = { ...target, sessionId };
export const command = {
  commandId: "continued",
  clientId: "test",
  sessionId,
  type: "sendText",
  payload: { text: "continue" },
  issuedAt: 1,
};
