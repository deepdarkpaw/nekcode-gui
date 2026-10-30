import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NekSessionStats, NekStatusFrame } from "@zcode/shared/nek-protocol";
import {
  createNekStatusFeed,
  getNekStatusActions,
  resetNekStatusFeedRegistry,
  type NekStatusFeedAgentService,
} from "./statusFeed.js";
import { useNekStatusStore } from "@/nek/status/store.js";

const stats: NekSessionStats = {
  sessionFile: undefined,
  sessionId: "s1",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
  cost: 0.01,
};

function createFakeService() {
  const listeners = new Set<(frame: NekStatusFrame) => void>();
  const getNekSessionStats = vi.fn(async () => stats);
  const clearNekQueue = vi.fn(async () => ({ steering: ["queued"], followUp: [] }));
  const requeueNekQueue = vi.fn(async () => undefined);
  const abortNekRetry = vi.fn(async () => undefined);
  const abortNekCompaction = vi.fn(async () => undefined);
  const compactNekSession = vi.fn(async () => undefined);
  const service: NekStatusFeedAgentService = {
    onDynamicNekStatusFrame: () => (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    getNekSessionStats,
    clearNekQueue,
    requeueNekQueue,
    abortNekRetry,
    abortNekCompaction,
    compactNekSession,
  };
  return { service, listeners, getNekSessionStats, clearNekQueue, requeueNekQueue };
}

function snapshotFrame(): NekStatusFrame {
  return {
    kind: "snapshot",
    sessionKey: "s1",
    snapshot: {
      sessionKey: "s1",
      running: false,
      state: { mode: "plan", todos: [], plans: [], subagents: [] },
      stats,
    },
  };
}

describe("NekStatusFeed", () => {
  beforeEach(() => {
    useNekStatusStore.getState().reset();
    resetNekStatusFeedRegistry();
  });

  it("feeds snapshots and subsequent events into the store", () => {
    const fake = createFakeService();
    const feed = createNekStatusFeed(fake.service, { workspacePath: "/workspace" });
    fake.listeners.forEach((listener) => listener(snapshotFrame()));
    fake.listeners.forEach((listener) =>
      listener({
        kind: "event",
        sessionKey: "s1",
        event: { type: "queue_update", steering: ["x"], followUp: [] },
      }),
    );
    const state = useNekStatusStore.getState().sessions.s1;
    expect(state?.mode).toBe("plan");
    expect(state?.stats?.tokens.total).toBe(30);
    expect(state?.queue.steering).toEqual(["x"]);
    feed.dispose();
    expect(getNekStatusActions("s1")).toBeUndefined();
  });

  it("routes status actions through the workspace service and cleans them on unsubscribe", async () => {
    const fake = createFakeService();
    const feed = createNekStatusFeed(fake.service, {
      workspacePath: "/workspace",
      workspaceIdentity: "workspace-id",
    });
    fake.listeners.forEach((listener) => listener(snapshotFrame()));
    const actions = getNekStatusActions("s1");
    expect(actions).toBeDefined();
    await actions?.clearQueue();
    await actions?.requeue({ steering: ["a"], followUp: ["b"] });
    expect(fake.clearNekQueue).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      workspaceIdentity: "workspace-id",
      sessionId: "s1",
    });
    expect(fake.requeueNekQueue).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      workspaceIdentity: "workspace-id",
      sessionId: "s1",
      queue: { steering: ["a"], followUp: ["b"] },
    });
    feed.dispose();
  });
});
