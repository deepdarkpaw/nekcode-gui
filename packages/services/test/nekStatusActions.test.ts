import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type {
  NekGuiInfo,
  NekRpcCommand,
  NekStatusFrame,
  NekStatusSnapshot,
} from "@zcode/shared/nek-protocol";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "../src/nek-agent/nekRpcClient.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import { createNekZCodeAgentService } from "../src/node.js";
import { createZCodeAgentConnectionScope } from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

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

const sessionState = {
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
} as const;

const sessionStats = {
  sessionFile: "/tmp/session.jsonl",
  sessionId: "s1",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 },
  cost: 0.5,
};

interface FakeProcess {
  process: NekRpcProcess;
  commands: NekRpcCommand[];
  emit(record: unknown): void;
}

function fakeProcess(kind: "control" | "session"): FakeProcess {
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
      const data = respond(kind, command);
      stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data })}\n`,
      );
    }
  });
  let exited = false;
  const emitExit = (info: NekRpcProcessExit) => {
    if (exited) return;
    exited = true;
    for (const listener of exits) listener(info);
  };
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
  return {
    commands,
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

function respond(kind: "control" | "session", command: NekRpcCommand): unknown {
  if (kind === "control") {
    if (command.type === "get_project_trust")
      return { cwd: command.cwd, resources: [], trusted: true, defaultProjectTrust: "always" };
    if (command.type === "list_sessions") return { sessions: [] };
    return {};
  }
  switch (command.type) {
    case "get_state":
      return sessionState;
    case "get_entries":
      return { entries: [], leafId: null };
    case "get_session_stats":
      return sessionStats;
    case "extension_call":
      return {
        result:
          command.method === "nek.get_state"
            ? { mode: "plan", todos: [], plans: [], subagents: [] }
            : {},
      };
    case "clear_queue":
      return { steering: ["steer me"], followUp: ["later"] };
    case "steer":
    case "follow_up":
      return { disposition: "queued" };
    case "compact":
      return { summary: "compacted", firstKeptEntryId: "e2", tokensBefore: 900 };
    default:
      return {};
  }
}

function createAdapter() {
  const control = fakeProcess("control");
  const session = fakeProcess("session");
  const service = createNekZCodeAgentService({
    guiInfo,
    askProjectTrust: () => true,
    createControlProcess: () => control.process,
    createSessionProcess: () => session.process,
  });
  return { service, session, control };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`condition did not become true in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** host 侧白名单口径：状态 feed 依赖的方法必须出现在 `IZCodeAgentService` 上。 */
const STATUS_METHODS = [
  "onDynamicNekStatusFrame",
  "getNekStatusSnapshot",
  "getNekSessionStats",
  "clearNekQueue",
  "requeueNekQueue",
  "abortNekRetry",
  "abortNekCompaction",
  "abortNekSession",
  "compactNekSession",
] as const satisfies readonly (keyof IZCodeAgentService)[];

test("host agent service exposes every status feed method", async () => {
  const { service } = createAdapter();
  try {
    for (const method of STATUS_METHODS) assert.equal(typeof service[method], "function", method);
  } finally {
    await service.disposeAll();
  }
});

test("publishes a status snapshot when a nek session opens", async () => {
  const { service, session } = createAdapter();
  const target = { workspacePath: "/workspace" };
  const frames: NekStatusFrame[] = [];
  const subscription = service.onDynamicNekStatusFrame(target)((frame) => frames.push(frame));
  try {
    const created = await service.createSession({ workspacePath: "/workspace" });
    await waitFor(() => frames.some((frame) => frame.kind === "snapshot"));
    const frame = frames.find((candidate) => candidate.kind === "snapshot");
    if (!frame || frame.kind !== "snapshot") throw new Error("expected a snapshot frame");
    assert.equal(frame.sessionKey, created.session.sessionId);
    assert.equal(frame.snapshot.sessionKey, created.session.sessionId);
    assert.equal(frame.snapshot.state.mode, "plan");
    assert.equal(frame.snapshot.stats.tokens.total, 7);
    assert.equal(frame.snapshot.running, false);
    assert.equal(
      session.commands.filter(
        (command) => command.type === "extension_call" && command.method === "nek.get_state",
      ).length > 0,
      true,
    );
  } finally {
    subscription.dispose();
    await service.disposeAll();
  }
});

test("projects nek RPC events into status frames for the workspace", async () => {
  const { service, session } = createAdapter();
  const target = { workspacePath: "/workspace" };
  const frames: NekStatusFrame[] = [];
  const subscription = service.onDynamicNekStatusFrame(target)((frame) => frames.push(frame));
  try {
    const created = await service.createSession({ workspacePath: "/workspace" });
    session.emit({ type: "queue_update", steering: ["next"], followUp: [] });
    session.emit({
      type: "extension_event",
      name: "nek.subagent",
      payload: {
        id: "child-1",
        description: "worker",
        type: "worker",
        background: false,
        status: "running",
        startedAt: 0,
      },
    });
    await waitFor(() =>
      frames.some((frame) => frame.kind === "event" && frame.event.type === "queue_update"),
    );
    const events = frames.flatMap((frame) => (frame.kind === "event" ? [frame.event] : []));
    assert.equal(events[0]?.type, "queue_update");
    assert.deepEqual(
      events.map((event) => event.type),
      ["queue_update", "extension_event"],
    );
    assert.equal(
      frames.every((frame) => frame.sessionKey === created.session.sessionId),
      true,
    );
  } finally {
    subscription.dispose();
    await service.disposeAll();
  }
});

test("routes status actions to nek RPCs and returns bounded queue contents", async () => {
  const { service, session } = createAdapter();
  const target = { workspacePath: "/workspace" };
  try {
    const created = await service.createSession({ workspacePath: "/workspace" });
    const scope = { ...target, sessionId: created.session.sessionId };
    assert.deepEqual(await service.clearNekQueue(scope), {
      steering: ["steer me"],
      followUp: ["later"],
    });
    await service.requeueNekQueue({
      ...scope,
      queue: { steering: ["a1", "a2"], followUp: ["b1"] },
    });
    await service.abortNekRetry(scope);
    await service.abortNekCompaction(scope);
    await service.abortNekSession(scope);
    await service.compactNekSession(scope);
    await service.getNekSessionStats(scope);
    const snapshot: NekStatusSnapshot = await service.getNekStatusSnapshot(scope);
    assert.equal(snapshot.compacting, false);
    assert.equal(snapshot.pendingMessageCount, 0);
    assert.deepEqual(
      session.commands.map((command) => command.type),
      [
        "get_state",
        "get_state",
        "get_entries",
        "get_session_stats",
        "extension_call",
        "clear_queue",
        "steer",
        "steer",
        "follow_up",
        "abort_retry",
        "abort",
        "abort",
        "compact",
        "get_session_stats",
        "get_state",
        "get_session_stats",
        "extension_call",
      ],
    );
    assert.deepEqual(
      session.commands
        .filter((command) => command.type === "steer")
        .map((command) => (command as { message: string }).message),
      ["a1", "a2"],
    );
  } finally {
    await service.disposeAll();
  }
});

test("rejects status actions for sessions that are not open", async () => {
  const { service } = createAdapter();
  try {
    await assert.rejects(
      service.abortNekRetry({ workspacePath: "/workspace", sessionId: "gone" }),
      /is not open/u,
    );
    await assert.rejects(
      service.getNekStatusSnapshot({ workspacePath: "/workspace", sessionId: "gone" }),
      /is not open/u,
    );
  } finally {
    await service.disposeAll();
  }
});

test("publishes a closed frame when the session closes", async () => {
  const { service } = createAdapter();
  const target = { workspacePath: "/workspace" };
  const frames: NekStatusFrame[] = [];
  const subscription = service.onDynamicNekStatusFrame(target)((frame) => frames.push(frame));
  try {
    const created = await service.createSession({ workspacePath: "/workspace" });
    await service.closeSession({
      workspacePath: "/workspace",
      sessionId: created.session.sessionId,
    });
    await waitFor(() => frames.some((frame) => frame.kind === "closed"));
    const closed = frames.find((frame) => frame.kind === "closed");
    assert.equal(closed?.sessionKey, created.session.sessionId);
  } finally {
    subscription.dispose();
    await service.disposeAll();
  }
});

test("host connection facade exposes the status feed and rejects it after dispose", async () => {
  const { service } = createAdapter();
  // 只实现 facade 触达的成员；其余成员被访问时立即报错，避免测试替身掩盖真实白名单。
  const base = new Proxy({} as Partial<IZCodeAgentService>, {
    get(_target, property) {
      if (property === "onDynamicNekStatusFrame")
        return (params: { workspacePath: string }) => service.onDynamicNekStatusFrame(params);
      if (property === "createSession")
        return (params: { workspacePath: string }) => service.createSession(params);
      if (property === "onAgentRuntimeLifecycle") return undefined;
      if (property === "onAgentRuntimeRestarted") return undefined;
      throw new Error(`fake agent service does not implement ${String(property)}`);
    },
  }) as IZCodeAgentService;
  const scope = createZCodeAgentConnectionScope(base, {
    connectionId: "connection-1",
    clientMode: "desktop-continuous",
  });
  try {
    const frames: NekStatusFrame[] = [];
    const subscription = scope.service.onDynamicNekStatusFrame({ workspacePath: "/workspace" })(
      (frame) => frames.push(frame),
    );
    const created = await scope.service.createSession({ workspacePath: "/workspace" });
    await waitFor(() => frames.some((frame) => frame.kind === "snapshot"));
    assert.equal(frames[0]?.sessionKey, created.session.sessionId);
    subscription.dispose();
  } finally {
    await scope.dispose();
    await service.disposeAll();
  }
  assert.throws(
    () => scope.service.onDynamicNekStatusFrame({ workspacePath: "/workspace" }),
    /closed|disposed|open/u,
  );
});
