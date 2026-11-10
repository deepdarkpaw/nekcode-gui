/**
 * 快照生命周期 fence：陈旧/关闭/换进程的快照必须显式失败，绝不冒充已装载。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import {
  NekSnapshotStaleError,
  initializeSessionState,
  reloadSessionSnapshot,
  type NekSessionSnapshotContext,
} from "../src/nek-agent/service/nekSessionSnapshotLoader.js";
import type { NekSessionPhase, NekSessionRecord } from "../src/nek-agent/service/types.js";

const state = {
  sessionId: "s1",
  sessionFile: "/tmp/session.jsonl",
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};
const stats = {
  sessionId: "s1",
  sessionFile: "/tmp/session.jsonl",
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

interface Harness {
  record: NekSessionRecord;
  context: NekSessionSnapshotContext;
  calls: string[];
  settled: () => number;
  boundPaths: () => number;
  phases: () => NekSessionPhase[];
}

function harness(overrides: Partial<NekSessionRecord> = {}): Harness {
  const calls: string[] = [];
  let settleCount = 0;
  let bindCount = 0;
  const phases: NekSessionPhase[] = [];
  const record: NekSessionRecord = {
    key: "session-a",
    sessionId: "s1",
    cwd: "/workspace",
    phase: "idle",
    readonly: false,
    stateEpoch: 0,
    ...overrides,
  };
  const projector = {
    loadSnapshot: () => {},
    flushNow: () => {},
  } as unknown as NekConversationProjector;
  const context: NekSessionSnapshotContext = {
    record,
    createProjector: () => projector,
    setPhase: (target, phase) => {
      phases.push(phase);
      target.phase = phase;
    },
    settlePendingInputs: () => {
      settleCount += 1;
    },
    bindPath: () => {
      bindCount += 1;
    },
  };
  return {
    record,
    context,
    calls,
    settled: () => settleCount,
    boundPaths: () => bindCount,
    phases: () => phases,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

/** 记录调用并按命令返回真实形状；`onCommand` 可以在应答前制造竞态。 */
function fakeProcess(
  calls: string[],
  onCommand: (type: string) => void | Promise<void> = () => {},
): NekRpcProcess {
  return {
    client: {
      call: async (command: { type: string }) => {
        calls.push(command.type);
        await onCommand(command.type);
        if (command.type === "get_state") return state;
        if (command.type === "get_entries") return { entries: [], leafId: null };
        if (command.type === "get_session_stats") return stats;
        if (command.type === "extension_call") return { result: undefined };
        throw new Error(`unexpected command ${command.type}`);
      },
    },
  } as unknown as NekRpcProcess;
}

test("世代一致时快照正常落地", async () => {
  const h = harness();
  const process = fakeProcess(h.calls);
  h.record.process = process;
  await reloadSessionSnapshot(h.context, process);
  assert.equal(h.record.state?.isCompacting, false);
  assert.equal(h.record.path, "/tmp/session.jsonl");
  assert.equal(h.settled(), 1);
  assert.equal(h.boundPaths(), 1);
  assert.deepEqual(h.phases(), ["idle"]);
});

test("SS-2: projection reload samples the child registry only after persisted entries finish", async () => {
  const h = harness();
  const gate = Promise.withResolvers<void>();
  const process = fakeProcess(h.calls, async (type) => {
    if (type === "get_entries") await gate.promise;
  });
  h.record.process = process;
  const pending = reloadSessionSnapshot(h.context, process);
  try {
    await flush();
    assert.ok(h.calls.includes("get_entries"));
    assert.ok(!h.calls.includes("extension_call"));
  } finally {
    gate.resolve();
    await pending;
  }
  assert.equal(h.settled(), 1);
});

test("连续 3 次生命周期世代变化后显式失败，不冒充装载成功", async () => {
  const h = harness();
  const process = fakeProcess(h.calls, (type) => {
    if (type === "get_entries") h.record.stateEpoch = (h.record.stateEpoch ?? 0) + 1;
  });
  h.record.process = process;
  await assert.rejects(reloadSessionSnapshot(h.context, process), (error: Error) => {
    assert.ok(error instanceof NekSnapshotStaleError);
    assert.equal(error.name, "NekSnapshotStaleError");
    assert.match(error.message, /retry/u);
    return true;
  });
  // 三次都取过状态，但一次都没有落地：没有覆盖状态、没有收口待发输入、没有绑定路径。
  assert.equal(h.calls.filter((type) => type === "get_state").length, 3);
  assert.equal(h.record.state, undefined);
  assert.equal(h.settled(), 0);
  assert.equal(h.boundPaths(), 0);
  assert.deepEqual(h.phases(), []);
});

test("initialize 在世代持续变化时同样显式失败，不谎报初始化完成", async () => {
  const h = harness();
  const process = fakeProcess(h.calls, (type) => {
    if (type === "get_state") h.record.stateEpoch = (h.record.stateEpoch ?? 0) + 1;
  });
  h.record.process = process;
  await assert.rejects(initializeSessionState(h.context, process), NekSnapshotStaleError);
  assert.equal(h.record.state, undefined);
});

test("关闭会话后迟到的快照不再落地（不绑路径、不覆盖状态、不收口旧队列）", async () => {
  const h = harness();
  const gate = Promise.withResolvers<void>();
  const process = fakeProcess(h.calls, async (type) => {
    if (type === "get_entries") await gate.promise;
  });
  h.record.process = process;
  const inFlight = reloadSessionSnapshot(h.context, process);
  await flush();
  h.record.closing = true;
  gate.resolve();
  await assert.rejects(inFlight, (error: Error) => {
    assert.ok(error instanceof NekSnapshotStaleError);
    assert.match(error.message, /closing/u);
    return true;
  });
  assert.equal(h.record.state, undefined);
  assert.equal(h.settled(), 0);
  assert.equal(h.boundPaths(), 0);
});

test("进程被更换后迟到的快照不再落地（旧进程结果不能写到新记录上）", async () => {
  const h = harness();
  const gate = Promise.withResolvers<void>();
  const oldProcess = fakeProcess(h.calls, async (type) => {
    if (type === "get_entries") await gate.promise;
  });
  const newProcess = fakeProcess(h.calls);
  h.record.process = oldProcess;
  const inFlight = reloadSessionSnapshot(h.context, oldProcess);
  await flush();
  h.record.process = newProcess;
  gate.resolve();
  await assert.rejects(inFlight, (error: Error) => {
    assert.ok(error instanceof NekSnapshotStaleError);
    assert.match(error.message, /process changed/u);
    return true;
  });
  assert.equal(h.record.state, undefined);
  assert.equal(h.settled(), 0);
  assert.equal(h.boundPaths(), 0);
});
