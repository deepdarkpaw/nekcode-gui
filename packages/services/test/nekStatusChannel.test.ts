import assert from "node:assert/strict";
import test from "node:test";
import {
  NEK_STATUS_FRAME_MAX_PLANS,
  NEK_STATUS_FRAME_MAX_QUEUE_ITEMS,
  NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS,
  NEK_STATUS_FRAME_MAX_SUBAGENTS,
  NEK_STATUS_FRAME_MAX_TEXT,
  NEK_STATUS_FRAME_MAX_TODOS,
  type NekRpcEvent,
  type NekSessionStats,
  type NekState,
  type NekStatusFrame,
  type NekStatusSnapshot,
} from "@zcode/shared/nek-protocol";
import {
  boundNekStatusSnapshot,
  boundNekStatusState,
  NekAgentStatusChannel,
  projectNekStatusEvent,
  type NekStatusChannelService,
} from "../src/nek-agent/adapter/nekAgentStatusChannel.js";
import type { NekAgentServiceEvent, NekSession } from "../src/nek-agent/service/types.js";

const stats: NekSessionStats = {
  sessionFile: "/tmp/s1.jsonl",
  sessionId: "s1",
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

function state(): NekState {
  return {
    mode: "agent",
    todos: Array.from({ length: NEK_STATUS_FRAME_MAX_TODOS + 20 }, (_, index) => ({
      id: `todo-${index}`,
      content: `Todo ${index} ${"x".repeat(NEK_STATUS_FRAME_MAX_TEXT)}`,
      status: "pending" as const,
    })),
    plans: Array.from({ length: NEK_STATUS_FRAME_MAX_PLANS + 10 }, (_, index) => ({
      path: `/plan/${index}`,
      name: `Plan ${index}`,
      overview: "overview",
      revision: 1,
      status: "ready" as const,
      todos: [],
    })),
    subagents: Array.from({ length: NEK_STATUS_FRAME_MAX_SUBAGENTS + 20 }, (_, index) => ({
      id: `agent-${index}`,
      description: "worker",
      type: "worker",
      background: false,
      status: "running" as const,
      startedAt: 0,
    })),
  };
}

function session(overrides: Partial<NekSession> = {}): NekSession {
  return {
    sessionKey: "record-1",
    sessionId: "s1",
    cwd: "/workspace",
    phase: "idle",
    readonly: false,
    ...overrides,
  };
}

function snapshot(sessionKey = "s1"): NekStatusSnapshot {
  return {
    sessionKey,
    running: false,
    compacting: false,
    pendingMessageCount: 0,
    state: { mode: "agent", todos: [], plans: [], subagents: [] },
    stats,
  };
}

function createFakeChannelService(openSessions: readonly NekSession[] = []) {
  const listeners = new Set<(event: NekAgentServiceEvent) => void>();
  const snapshotCalls: string[] = [];
  const service: NekStatusChannelService = {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listOpenSessions: (cwd) => openSessions.filter((candidate) => candidate.cwd === cwd),
    getStatusSnapshot: async (sessionKey) => {
      snapshotCalls.push(sessionKey);
      return snapshot(sessionKey === "record-1" ? "s1" : sessionKey);
    },
  };
  return {
    service,
    snapshotCalls,
    listenerCount: () => listeners.size,
    emit: (event: NekAgentServiceEvent) => {
      for (const listener of Array.from(listeners)) listener(event);
    },
    emitRpc: (rpcEvent: NekRpcEvent, target: NekSession = session()) => {
      for (const listener of Array.from(listeners))
        listener({ type: "rpc_event", session: target, event: rpcEvent });
    },
  };
}

test("projects queue updates with frame bounds", () => {
  const projected = projectNekStatusEvent({
    type: "queue_update",
    steering: Array.from({ length: 120 }, (_, index) => `steer-${index}`),
    followUp: [`follow-${"y".repeat(NEK_STATUS_FRAME_MAX_TEXT + 10)}`],
  });
  assert.equal(projected?.type, "queue_update");
  if (projected?.type !== "queue_update") throw new Error("queue event was not projected");
  assert.equal(projected.steering.length, NEK_STATUS_FRAME_MAX_QUEUE_ITEMS);
  assert.equal(projected.followUp[0]?.length, NEK_STATUS_FRAME_MAX_TEXT);
});

test("projects nek.state with frame bounds and is idempotent", () => {
  const projected = projectNekStatusEvent({
    type: "extension_event",
    name: "nek.state",
    payload: state(),
  });
  assert.equal(projected?.type, "extension_event");
  if (projected?.type !== "extension_event") throw new Error("state event was not projected");
  const bounded = projected.payload as NekState;
  assert.equal(bounded.todos.length, NEK_STATUS_FRAME_MAX_TODOS);
  assert.equal(bounded.todos[0]?.content.length, NEK_STATUS_FRAME_MAX_TEXT);
  assert.equal(bounded.plans.length, NEK_STATUS_FRAME_MAX_PLANS);
  assert.equal(bounded.subagents.length, NEK_STATUS_FRAME_MAX_SUBAGENTS);
  assert.deepEqual(boundNekStatusState(bounded), bounded);
  // 快照裁剪同样有界且幂等。
  const first = boundNekStatusSnapshot({ ...snapshot(), state: state() });
  assert.deepEqual(boundNekStatusSnapshot(first), first);
});

test("strips message payloads and drops records the status views do not consume", () => {
  assert.deepEqual(projectNekStatusEvent({ type: "message_start", message: { huge: "x" } }), {
    type: "message_start",
  });
  assert.deepEqual(projectNekStatusEvent({ type: "message_end", message: { huge: "x" } }), {
    type: "message_end",
  });
  const ignored: NekRpcEvent[] = [
    { type: "tool_execution_start", toolCallId: "t", toolName: "ls", args: {} },
    { type: "entry_appended", entry: { type: "message", id: "e1" } },
    { type: "extension_ui_cancel", id: "request" },
    { type: "bash_execution_update", delta: "x" },
    { type: "agent_end", messages: [], willRetry: false },
  ];
  for (const event of ignored) assert.equal(projectNekStatusEvent(event), null, event.type);
  assert.equal(
    projectNekStatusEvent({ type: "extension_event", name: "nek.state", payload: { mode: "x" } }),
    null,
  );
  assert.equal(
    projectNekStatusEvent({ type: "extension_event", name: "nek.subagent", payload: { id: 1 } }),
    null,
  );
  assert.equal(
    projectNekStatusEvent({ type: "extension_event", name: "mcp.status_changed", payload: {} }),
    null,
  );
  assert.equal(
    projectNekStatusEvent({
      type: "queue_update",
      steering: [1] as unknown as string[],
      followUp: [],
    }),
    null,
  );
});

test("keeps duplicate and out-of-order status events unchanged", () => {
  const queue: NekRpcEvent = { type: "queue_update", steering: ["a"], followUp: ["b"] };
  assert.deepEqual(projectNekStatusEvent(queue), projectNekStatusEvent(queue));
  // 终态之后再来的 running 由 renderer reducer 决定（ST-2）；投影层不得自行改写状态顺序。
  const running = projectNekStatusEvent({
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
  if (running?.type !== "extension_event") throw new Error("subagent event was not projected");
  assert.equal((running.payload as { status: string }).status, "running");
  // 重试事件的错误文本同样裁剪，不因重复投影而变长。
  const retry = projectNekStatusEvent({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 500,
    errorMessage: "e".repeat(NEK_STATUS_FRAME_MAX_TEXT + 1),
  });
  if (retry?.type !== "auto_retry_start") throw new Error("retry event was not projected");
  assert.equal(retry.errorMessage.length, NEK_STATUS_FRAME_MAX_TEXT);
});

test("routes frames by workspace path for path and identity scoped subscriptions", () => {
  const fake = createFakeChannelService();
  const channel = new NekAgentStatusChannel(fake.service, undefined);
  const pathFrames: NekStatusFrame[] = [];
  const identityFrames: NekStatusFrame[] = [];
  const otherFrames: NekStatusFrame[] = [];
  const pathSub = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
    pathFrames.push(frame),
  );
  const identitySub = channel.onDynamic({
    workspacePath: "/workspace",
    workspaceIdentity: "ssh-host:/workspace",
  })((frame) => identityFrames.push(frame));
  const otherSub = channel.onDynamic({ workspacePath: "/other" })((frame) =>
    otherFrames.push(frame),
  );
  fake.emitRpc({ type: "agent_start" });
  assert.equal(pathFrames.length, 1);
  assert.equal(identityFrames.length, 1);
  assert.equal(otherFrames.length, 0);
  const frame = pathFrames[0];
  assert.equal(frame?.kind, "event");
  if (frame?.kind !== "event") throw new Error("expected an event frame");
  assert.equal(frame.sessionKey, "s1");
  assert.equal(frame.event.type, "agent_start");
  pathSub.dispose();
  identitySub.dispose();
  otherSub.dispose();
  channel.dispose();
  assert.equal(fake.listenerCount(), 0);
});

test("publishes one bounded snapshot per open session to the first subscriber", async () => {
  const sessions = [
    session({ sessionKey: "record-1", sessionId: "s1" }),
    session({ sessionKey: "record-locked", sessionId: "s2", readonly: true, phase: "locked" }),
    ...Array.from({ length: NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS + 3 }, (_, index) =>
      session({ sessionKey: `record-${index + 10}`, sessionId: `s${index + 10}` }),
    ),
  ];
  const fake = createFakeChannelService(sessions);
  const channel = new NekAgentStatusChannel(fake.service, { warn: () => {} });
  const firstFrames: NekStatusFrame[] = [];
  const secondFrames: NekStatusFrame[] = [];
  const first = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
    firstFrames.push(frame),
  );
  const second = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
    secondFrames.push(frame),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.snapshotCalls.length, NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS);
  assert.equal(fake.snapshotCalls.includes("record-locked"), false);
  // 同一 workspace 的两个 pane 共享一次补齐：两个订阅者都拿到同样 20 帧，服务侧只读 20 次。
  assert.equal(firstFrames.length, NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS);
  assert.equal(secondFrames.length, NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS);
  first.dispose();
  second.dispose();
  channel.dispose();
});

test("publishes snapshots only while a renderer is subscribed", async () => {
  const fake = createFakeChannelService();
  const channel = new NekAgentStatusChannel(fake.service, undefined);
  channel.publish({ workspacePath: "/workspace" }, "record-1");
  channel.publishClosed({ workspacePath: "/workspace" }, "s1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fake.snapshotCalls.length, 0);
  const frames: NekStatusFrame[] = [];
  const subscription = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
    frames.push(frame),
  );
  channel.publish({ workspacePath: "/workspace" }, "record-1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  channel.publishClosed({ workspacePath: "/workspace" }, "s1");
  assert.deepEqual(fake.snapshotCalls, ["record-1"]);
  assert.deepEqual(
    frames.map((frame) => frame.kind),
    ["snapshot", "closed"],
  );
  subscription.dispose();
  // 最后一个订阅者离开后不再转发，也不再向服务登记。
  fake.emitRpc({ type: "agent_start" });
  assert.equal(frames.length, 2);
  assert.equal(fake.listenerCount(), 0);
  channel.dispose();
});

test("forwards process exit as a status event", () => {
  const fake = createFakeChannelService();
  const channel = new NekAgentStatusChannel(fake.service, undefined);
  const frames: NekStatusFrame[] = [];
  const subscription = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
    frames.push(frame),
  );
  fake.emit({ type: "process_exit", session: session(), exit: { code: 1, signal: null } });
  assert.deepEqual(
    frames.map((frame) => (frame.kind === "event" ? frame.event.type : frame.kind)),
    ["process_exit"],
  );
  subscription.dispose();
  channel.dispose();
});

test("logs a failed snapshot instead of publishing a partial one", async () => {
  const warnings: unknown[] = [];
  const service: NekStatusChannelService = {
    onEvent: () => () => {},
    listOpenSessions: () => [session()],
    getStatusSnapshot: async () => {
      throw new Error("nek session record-1 is read-only (nek)");
    },
  };
  const channel = new NekAgentStatusChannel(service, { warn: (...args) => warnings.push(args) });
  const frames: NekStatusFrame[] = [];
  const subscription = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
    frames.push(frame),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(frames.length, 0);
  assert.equal(warnings.length, 1);
  subscription.dispose();
  channel.dispose();
});
