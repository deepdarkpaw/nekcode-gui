/**
 * 磁盘会话恢复相关测试的共享替身：真实 adapter / service / 进程池 / 投影器，
 * 只把 nek 进程换成内存 JSONL 传输。
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type {
  NekGuiInfo,
  NekRpcCommand,
  NekSessionSnapshot,
  NekSessionSummary,
  NekSessionEntry,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";
import { NekRpcClient, type NekRpcProcessExit } from "../src/nek-agent/nekRpcClient.js";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";

export const target = { workspacePath: "/project" };
export const sessionId = "disk-session";
export const sessionPath = "/sessions/disk.jsonl";
export const guiInfo: NekGuiInfo = {
  protocolVersion: 1,
  capabilities: { promptAttachments: 1 },
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
export function createProcess(reply: (command: NekRpcCommand) => unknown | Promise<unknown>) {
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
  let disposed = false;
  const process: NekRpcProcess = {
    client,
    guiInfo,
    exitInfo: () => undefined,
    onExit: (listener) => handle.onExit(listener),
    dispose: async () => {
      disposed = true;
      handle.kill();
      await client.close();
    },
  };
  /** 模拟 nek 主动推送的 RPC 事件（JSONL 一行）。 */
  const emit = (record: Record<string, unknown>) => stdout.write(`${JSON.stringify(record)}\n`);
  return { process, commands, emit, isDisposed: () => disposed };
}

export function harness(
  options: {
    lockedBy?: NekSessionSnapshot["lockedBy"];
    failEntries?: boolean;
    /** CLI 历史条目；控制进程快照与会话进程读取同一份事实。 */
    entries?: NekSessionEntry[];
    /** 目录里额外的会话摘要（例如没有消息的草稿会话）。 */
    extraSessions?: NekSessionSummary[];
    /** 会话进程 `get_state` 报告的消息数（新建且未发送的会话为 0）。 */
    messageCount?: number;
    /** 附件上传暂存目录（测试用临时目录，不能落到真实数据目录）。 */
    attachmentStagingDir?: string;
    subagents?: NekSubagentRecord[];
    childSnapshots?: NekSessionSnapshot[];
    subagentMessages?: unknown[];
  } = {},
) {
  let failEntries = options.failEntries ?? false;
  let snapshotFailure: Error | undefined;
  let release: (() => void) | undefined;
  let barrier: Promise<void> | undefined;
  const entries = options.entries ?? [entry];
  const snapshot: NekSessionSnapshot = {
    session: { ...summary, locked: !!options.lockedBy },
    lockedBy: options.lockedBy,
    entries,
    messages: entries.flatMap((item) => (item.type === "message" ? [item.message] : [])),
    leafId: entries.at(-1)?.id ?? null,
  };
  const control = createProcess(async (command) => {
    if (command.type === "list_sessions")
      return { sessions: [snapshot.session, ...(options.extraSessions ?? [])] };
    // 与 nek 一致：会话进程还活着（持锁）时拒绝删除。
    if (command.type === "delete_session" && sessions.some((session) => !session.isDisposed()))
      throw new Error(`Session is locked by a live process: ${command.sessionPath}`);
    if (command.type === "read_session_snapshot") {
      const child = options.childSnapshots?.find(
        (item) => item.session.path === command.sessionPath,
      );
      if (child) return child;
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
    // workspace-config 目录（task index 摄入也会订阅）读模型列表。
    if (command.type === "get_available_models") return { models: [] };
    return {};
  });
  const sessions: ReturnType<typeof createProcess>[] = [];
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    ...(options.attachmentStagingDir ? { attachmentStagingDir: options.attachmentStagingDir } : {}),
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      // 新建会话没有 sessionPath；恢复只能恢复这一个磁盘会话。
      if (request.sessionPath !== undefined) assert.equal(request.sessionPath, sessionPath);
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
            messageCount: options.messageCount ?? 1,
            pendingMessageCount: 0,
          };
        if (command.type === "get_entries") {
          if (failEntries) {
            failEntries = false;
            throw new Error("entries load failed");
          }
          const end =
            command.beforeEntryId === undefined
              ? entries.length
              : entries.findIndex((item) => item.id === command.beforeEntryId);
          if (end < 0) throw new Error(`Entry not found: ${command.beforeEntryId}`);
          const start = command.limit === undefined ? 0 : Math.max(0, end - command.limit);
          return {
            entries: entries.slice(start, end),
            leafId: snapshot.leafId,
            hasMore: start > 0,
          };
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
        if (command.type === "extension_call") {
          if (command.method === "nek.get_subagent_transcript")
            return { result: { messages: options.subagentMessages ?? [] } };
          return {
            result: { mode: "agent", todos: [], plans: [], subagents: options.subagents ?? [] },
          };
        }
        if (command.type === "prompt") return { disposition: "started" };
        if (command.type === "get_available_models") return { models: [] };
        if (command.type === "get_commands") return { commands: [] };
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
