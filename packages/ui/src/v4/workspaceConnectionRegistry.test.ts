// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NekStatusFrame } from "@zcode/shared/nek-protocol";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
} from "./workspaceConnectionRegistry.js";
import { useNekStatusStore } from "@/nek/status/store.js";
import {
  getNekStatusActions,
  resetNekStatusActionRegistry,
} from "@/nek/statusFeed/statusActions.js";

/**
 * renderer 侧白名单口径：状态 feed 依赖的方法必须出现在 `WorkspaceConnectionAgentService` 里。
 * 类型检查在 `pnpm typecheck` 阶段执行；运行期断言保证这份清单不会被人删空。
 */
const RENDERER_STATUS_FEED_METHODS = [
  "onDynamicNekStatusFrame",
  "getNekSessionStats",
  "clearNekQueue",
  "requeueNekQueue",
  "abortNekRetry",
  "abortNekCompaction",
  "abortNekSession",
  "compactNekSession",
] as const satisfies readonly (keyof WorkspaceConnectionAgentService)[];

function snapshotFrame(sessionKey: string): NekStatusFrame {
  return {
    kind: "snapshot",
    sessionKey,
    snapshot: {
      sessionKey,
      running: false,
      compacting: false,
      pendingMessageCount: 0,
      state: { mode: "agent", todos: [], plans: [], subagents: [] },
      stats: {
        sessionFile: undefined,
        sessionId: sessionKey,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      },
    },
  };
}

function createFakeAgentService() {
  const listeners = new Set<(frame: NekStatusFrame) => void>();
  const agentService: WorkspaceConnectionAgentService = {
    helloConversationV4: vi.fn(),
    initializeConversationV4: vi.fn(),
    subscribeConversationV4: vi.fn(),
    resyncConversationV4: vi.fn(),
    unsubscribeConversationV4: vi.fn(),
    sendConversationCommandV4: vi.fn(),
    queryConversationCommandsV4: vi.fn(),
    conversationRowsRangeV4: vi.fn(),
    conversationPlansV4: vi.fn(),
    conversationFileChangesV4: vi.fn(),
    conversationFileRewindPreviewV4: vi.fn(),
    attachmentBeginV4: vi.fn(),
    attachmentChunkV4: vi.fn(),
    attachmentCommitV4: vi.fn(),
    attachmentAbortV4: vi.fn(),
    attachmentPreviewSourceV4: vi.fn(),
    attachmentReadV4: vi.fn(),
    onDynamicConversationFrame: vi.fn(() => () => ({ dispose: () => {} })),
    // nek status feed
    onDynamicNekStatusFrame: vi.fn(() => {
      return (listener: (frame: NekStatusFrame) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      };
    }),
    getNekSessionStats: vi.fn(),
    clearNekQueue: vi.fn(),
    requeueNekQueue: vi.fn(),
    abortNekRetry: vi.fn(),
    abortNekCompaction: vi.fn(),
    abortNekSession: vi.fn(),
    compactNekSession: vi.fn(),
    onDynamicLocalTtftFacts: vi.fn(() => () => ({ dispose: () => {} })),
    onAgentRuntimeRestarted: vi.fn(() => ({ dispose: () => {} })),
  };
  return {
    agentService,
    listenerCount: () => listeners.size,
    emit: (frame: NekStatusFrame) => {
      for (const listener of Array.from(listeners)) listener(frame);
    },
  };
}

describe("workspace connection registry status feed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNekStatusStore.getState().reset();
    resetNekStatusActionRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists every status feed method in the renderer agent service surface", () => {
    for (const method of RENDERER_STATUS_FEED_METHODS) expect(typeof method).toBe("string");
  });

  it("subscribes the workspace status feed on acquire and writes frames into the store", () => {
    const fake = createFakeAgentService();
    const lease = acquireWorkspaceConnection(
      { workspacePath: "/registry-acquire" },
      fake.agentService,
    );
    expect(fake.agentService.onDynamicNekStatusFrame).toHaveBeenCalledWith({
      workspacePath: "/registry-acquire",
    });
    expect(fake.listenerCount()).toBe(1);
    fake.emit(snapshotFrame("session-registry-1"));
    expect(useNekStatusStore.getState().sessions["session-registry-1"]?.stats).toBeDefined();
    expect(getNekStatusActions("session-registry-1")).toBeDefined();
    lease.release();
    vi.advanceTimersByTime(30_000);
  });

  it("unsubscribes and clears the session when the keep-warm window expires", () => {
    const fake = createFakeAgentService();
    const lease = acquireWorkspaceConnection(
      { workspacePath: "/registry-release" },
      fake.agentService,
    );
    fake.emit(snapshotFrame("session-registry-2"));
    expect(fake.listenerCount()).toBe(1);
    lease.release();
    vi.advanceTimersByTime(30_000);
    expect(fake.listenerCount()).toBe(0);
    expect(useNekStatusStore.getState().sessions["session-registry-2"]).toBeUndefined();
    expect(getNekStatusActions("session-registry-2")).toBeUndefined();
  });

  it("shares one feed per workspace while another lease still holds it", () => {
    const fake = createFakeAgentService();
    const first = acquireWorkspaceConnection(
      { workspacePath: "/registry-shared" },
      fake.agentService,
    );
    const second = acquireWorkspaceConnection(
      { workspacePath: "/registry-shared" },
      fake.agentService,
    );
    expect(fake.agentService.onDynamicNekStatusFrame).toHaveBeenCalledTimes(1);
    fake.emit(snapshotFrame("session-registry-3"));
    first.release();
    expect(fake.listenerCount()).toBe(1);
    expect(useNekStatusStore.getState().sessions["session-registry-3"]).toBeDefined();
    second.release();
    vi.advanceTimersByTime(30_000);
    expect(fake.listenerCount()).toBe(0);
  });
});
