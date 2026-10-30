// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NekSessionStats,
  NekStatusFrame,
  NekStatusSnapshot,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import {
  createNekStatusFeed,
  type NekStatusFeedAgentService,
  type NekStatusFeedHandle,
} from "./statusFeed.js";
import {
  getNekStatusActions,
  nekStatusActionSessionCount,
  resetNekStatusActionRegistry,
  useNekStatusActions,
} from "./statusActions.js";
import { useNekStatusStore } from "@/nek/status/store.js";
import { NEK_STATUS_MAX_SESSIONS } from "@/nek/status/types.js";

const stats: NekSessionStats = {
  sessionFile: "/tmp/s1.jsonl",
  sessionId: "s1",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
  cost: 0.01,
};

function subagent(id: string, status: NekSubagentRecord["status"]): NekSubagentRecord {
  return {
    id,
    description: `子代理 ${id}`,
    type: "worker",
    background: false,
    status,
    startedAt: 0,
    ...(status === "running" ? {} : { endedAt: 1 }),
  };
}

function snapshot(overrides: Partial<NekStatusSnapshot> = {}): NekStatusSnapshot {
  return {
    sessionKey: "s1",
    running: false,
    compacting: false,
    pendingMessageCount: 0,
    state: { mode: "plan", todos: [], plans: [], subagents: [] },
    stats,
    ...overrides,
  };
}

function snapshotFrame(overrides: Partial<NekStatusSnapshot> = {}): NekStatusFrame {
  const value = snapshot(overrides);
  return { kind: "snapshot", sessionKey: value.sessionKey, snapshot: value };
}

function eventFrame(
  sessionKey: string,
  event: Extract<NekStatusFrame, { kind: "event" }>["event"],
): NekStatusFrame {
  return { kind: "event", sessionKey, event };
}

function createFakeService() {
  const listeners = new Set<(frame: NekStatusFrame) => void>();
  const service: NekStatusFeedAgentService = {
    onDynamicNekStatusFrame: vi.fn(() => (listener: (frame: NekStatusFrame) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    }),
    getNekSessionStats: vi.fn(async () => stats),
    clearNekQueue: vi.fn(async () => ({ steering: ["queued"], followUp: [] })),
    requeueNekQueue: vi.fn(async () => undefined),
    abortNekRetry: vi.fn(async () => undefined),
    abortNekCompaction: vi.fn(async () => undefined),
    abortNekSession: vi.fn(async () => undefined),
    compactNekSession: vi.fn(async () => undefined),
  };
  return {
    service,
    listenerCount: () => listeners.size,
    emit: (frame: NekStatusFrame) => {
      for (const listener of Array.from(listeners)) listener(frame);
    },
  };
}

const target = { workspacePath: "/workspace", remoteSessionId: "remote-1" };

/** 推进已排队的微任务链（stats 刷新是 promise 链，不涉及真实计时器）。 */
async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("nek status feed", () => {
  let feeds: NekStatusFeedHandle[];

  beforeEach(() => {
    vi.useRealTimers();
    useNekStatusStore.getState().reset();
    resetNekStatusActionRegistry();
    feeds = [];
  });

  afterEach(() => {
    for (const feed of feeds) feed.dispose();
    vi.useRealTimers();
  });

  function start(service: NekStatusFeedAgentService): NekStatusFeedHandle {
    const feed = createNekStatusFeed(service, target);
    feeds.push(feed);
    return feed;
  }

  it("subscribes once per workspace and forgets the session when the feed is disposed", () => {
    const fake = createFakeService();
    const feed = start(fake.service);
    expect(fake.service.onDynamicNekStatusFrame).toHaveBeenCalledWith(target);
    expect(fake.listenerCount()).toBe(1);
    act(() => fake.emit(snapshotFrame()));
    expect(useNekStatusStore.getState().sessions.s1?.mode).toBe("plan");
    expect(getNekStatusActions("s1")).toBeDefined();
    feed.dispose();
    expect(fake.listenerCount()).toBe(0);
    expect(useNekStatusStore.getState().sessions.s1).toBeUndefined();
    expect(getNekStatusActions("s1")).toBeUndefined();
  });

  it("applies a snapshot as one authoritative update (mode, subagents, stats, cleared queue)", () => {
    const fake = createFakeService();
    start(fake.service);
    act(() => {
      fake.emit(eventFrame("s1", { type: "queue_update", steering: ["a"], followUp: [] }));
      fake.emit(
        eventFrame("s1", {
          type: "compaction_start",
          reason: "manual",
        }),
      );
    });
    expect(useNekStatusStore.getState().sessions.s1?.queue.steering).toEqual(["a"]);

    act(() =>
      fake.emit(
        snapshotFrame({
          running: true,
          pendingMessageCount: 0,
          state: {
            mode: "agent",
            todos: [{ id: "t1", content: "写测试", status: "pending" }],
            plans: [],
            subagents: [subagent("child-1", "completed")],
          },
        }),
      ),
    );
    const status = useNekStatusStore.getState().sessions.s1;
    expect(status?.running).toBe(true);
    expect(status?.mode).toBe("agent");
    expect(status?.todos.map((todo) => todo.id)).toEqual(["t1"]);
    expect(status?.subagents.byId["child-1"]?.status).toBe("completed");
    // 快照里 pendingMessageCount=0 与 compacting=false 是权威事实：收掉空队列与已结束的压缩横幅。
    expect(status?.queue).toEqual({ steering: [], followUp: [] });
    expect(status?.compaction).toBeNull();
    expect(status?.stats?.tokens.total).toBe(30);
    expect(status?.statsStale).toBe(false);
  });

  it("drops the session on a closed frame", () => {
    const fake = createFakeService();
    start(fake.service);
    act(() => fake.emit(snapshotFrame()));
    expect(useNekStatusStore.getState().sessions.s1).toBeDefined();
    act(() => fake.emit({ kind: "closed", sessionKey: "s1" }));
    expect(useNekStatusStore.getState().sessions.s1).toBeUndefined();
    expect(getNekStatusActions("s1")).toBeUndefined();
  });

  it("refreshes usage once per throttle window and keeps the trailing refresh", async () => {
    vi.useFakeTimers();
    const fake = createFakeService();
    vi.mocked(fake.service.getNekSessionStats).mockResolvedValue({ ...stats, cost: 2 });
    start(fake.service);
    act(() => {
      fake.emit(eventFrame("s1", { type: "agent_settled" }));
    });
    await flushPromises();
    expect(fake.service.getNekSessionStats).toHaveBeenCalledTimes(1);
    // 同一秒内的第二次 message_end 被节流，尾随定时器补上最后一次刷新。
    act(() => {
      fake.emit(eventFrame("s1", { type: "message_end" }));
    });
    await flushPromises();
    expect(fake.service.getNekSessionStats).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await flushPromises();
    });
    expect(fake.service.getNekSessionStats).toHaveBeenCalledTimes(2);
    expect(useNekStatusStore.getState().sessions.s1?.stats?.cost).toBe(2);
  });

  it("keeps the last usage values and logs when the stats refresh fails", async () => {
    const fake = createFakeService();
    vi.mocked(fake.service.getNekSessionStats).mockRejectedValue(new Error("nek is gone"));
    start(fake.service);
    act(() => {
      fake.emit(snapshotFrame());
    });
    act(() => {
      fake.emit(eventFrame("s1", { type: "message_end" }));
    });
    await flushPromises();
    expect(fake.service.getNekSessionStats).toHaveBeenCalledTimes(1);
    const status = useNekStatusStore.getState().sessions.s1;
    expect(status?.stats?.tokens.total).toBe(30);
    expect(status?.statsStale).toBe(true);
  });

  it("routes every state action to the workspace-scoped service method", async () => {
    const fake = createFakeService();
    start(fake.service);
    act(() => fake.emit(snapshotFrame()));
    const actions = getNekStatusActions("s1");
    expect(actions).toBeDefined();
    const scope = { ...target, sessionId: "s1" };
    await actions?.abort();
    await actions?.abortRetry();
    await actions?.abortCompaction();
    await actions?.compact();
    await actions?.clearQueue();
    await actions?.requeue({ steering: ["a"], followUp: ["b"] });
    expect(fake.service.abortNekSession).toHaveBeenCalledWith(scope);
    expect(fake.service.abortNekRetry).toHaveBeenCalledWith(scope);
    expect(fake.service.abortNekCompaction).toHaveBeenCalledWith(scope);
    expect(fake.service.compactNekSession).toHaveBeenCalledWith(scope);
    expect(fake.service.clearNekQueue).toHaveBeenCalledWith(scope);
    expect(fake.service.requeueNekQueue).toHaveBeenCalledWith({
      ...scope,
      queue: { steering: ["a"], followUp: ["b"] },
    });
  });

  it("surfaces action failures to the caller instead of swallowing them", async () => {
    const fake = createFakeService();
    vi.mocked(fake.service.abortNekRetry).mockRejectedValue(new Error("nek rejected abort_retry"));
    start(fake.service);
    act(() => fake.emit(snapshotFrame()));
    await expect(getNekStatusActions("s1")?.abortRetry()).rejects.toThrow(/abort_retry/u);
  });

  it("bounds the action registry to the store session limit", () => {
    const fake = createFakeService();
    start(fake.service);
    act(() => {
      for (let index = 0; index < NEK_STATUS_MAX_SESSIONS + 5; index += 1) {
        fake.emit(snapshotFrame({ sessionKey: `s${index}` }));
      }
    });
    expect(nekStatusActionSessionCount()).toBe(NEK_STATUS_MAX_SESSIONS);
    expect(getNekStatusActions("s0")).toBeUndefined();
    expect(getNekStatusActions(`s${NEK_STATUS_MAX_SESSIONS + 4}`)).toBeDefined();
  });

  it("makes actions visible to React consumers when the feed arrives after the first render", () => {
    const fake = createFakeService();
    const { result } = renderHook(() => useNekStatusActions("s1"));
    expect(result.current).toBeUndefined();
    start(fake.service);
    act(() => fake.emit(snapshotFrame()));
    expect(result.current?.abortRetry).toBeTypeOf("function");
  });
});
