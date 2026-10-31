/**
 * workspace 级 nek 状态 feed：把服务层状态帧写进 `useNekStatusStore`。
 *
 * 一个 workspace 一条订阅（本地与远程共用同一形状）；会话标识由帧自带，
 * 所以 pane 打开/关闭不需要重订阅。feed 只负责"帧 → store"，状态归约仍在 reducer 里。
 */
import type { IDisposable } from "@zcode/rpc";
import type { NekStatusFrame, NekStatusQueue } from "@zcode/shared/nek-protocol";
import type {
  IZCodeAgentService,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { useNekStatusStore } from "@/nek/status/store.js";
import {
  NEK_STATUS_MAX_SESSIONS,
  NEK_STATUS_STATS_THROTTLE_MS,
  type NekStatusEventOutput,
} from "@/nek/status/types.js";
import {
  deleteNekStatusActions,
  setNekStatusActions,
  type NekStatusActions,
} from "@/nek/statusFeed/statusActions.js";

/** feed 依赖的 agent 服务窄面：与 `IZCodeAgentService` 的 nek status 方法一一对应。 */
export type NekStatusFeedAgentService = Pick<
  IZCodeAgentService,
  | "onDynamicNekStatusFrame"
  | "getNekSessionStats"
  | "clearNekQueue"
  | "requeueNekQueue"
  | "abortNekRetry"
  | "abortNekCompaction"
  | "abortNekSession"
  | "compactNekSession"
>;

export interface NekStatusFeedHandle {
  dispose: () => void;
  /**
   * 换掉输出回调。同 workspace 的多个 pane 共享一条 feed（registry 引用计数），
   * 后接入的 pane 用新回调（例如语言切换后的新 intl 实例）覆盖旧的，
   * 不重建订阅、不丢事件。
   */
  setOptions: (options: NekStatusFeedOptions) => void;
}

export interface NekStatusFeedOptions {
  onOutput?: (sessionKey: string, output: NekStatusEventOutput) => void;
}

function sessionTarget(
  target: ZCodeAgentWorkspaceTarget,
  sessionId: string,
): ZCodeAgentSessionTarget {
  return { ...target, sessionId };
}

function createActions(
  agentService: NekStatusFeedAgentService,
  target: ZCodeAgentWorkspaceTarget,
  sessionKey: string,
): NekStatusActions {
  const input = () => sessionTarget(target, sessionKey);
  return {
    abort: () => agentService.abortNekSession(input()),
    abortRetry: () => agentService.abortNekRetry(input()),
    abortCompaction: () => agentService.abortNekCompaction(input()),
    compact: () => agentService.compactNekSession(input()),
    clearQueue: () => agentService.clearNekQueue(input()),
    requeue: (queue: NekStatusQueue) => agentService.requeueNekQueue({ ...input(), queue }),
  };
}

class NekStatusFeed implements NekStatusFeedHandle {
  private readonly ownedSessionKeys = new Set<string>();
  private readonly statsRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly statsRefreshVersions = new Map<string, number>();
  private subscription: IDisposable | undefined;
  private disposed = false;

  constructor(
    private readonly agentService: NekStatusFeedAgentService,
    private readonly target: ZCodeAgentWorkspaceTarget,
    private options: NekStatusFeedOptions,
  ) {}

  setOptions(options: NekStatusFeedOptions): void {
    this.options = options;
  }

  start(): void {
    this.subscription = this.agentService.onDynamicNekStatusFrame(this.target)((frame) =>
      this.onFrame(frame),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription?.dispose();
    this.subscription = undefined;
    for (const timer of this.statsRefreshTimers.values()) clearTimeout(timer);
    this.statsRefreshTimers.clear();
    this.statsRefreshVersions.clear();
    for (const sessionKey of this.ownedSessionKeys) {
      deleteNekStatusActions(sessionKey);
      useNekStatusStore.getState().removeSession(sessionKey);
    }
    this.ownedSessionKeys.clear();
  }

  private onFrame(frame: NekStatusFrame): void {
    if (this.disposed) return;
    if (frame.kind === "closed") {
      this.forgetSession(frame.sessionKey);
      return;
    }
    this.trackSession(frame.sessionKey);
    const store = useNekStatusStore.getState();
    if (frame.kind === "snapshot") {
      const output = store.consumeEvent(frame.sessionKey, {
        type: "session_snapshot",
        payload: frame.snapshot,
      });
      this.options.onOutput?.(frame.sessionKey, output);
      return;
    }
    const output = store.consumeEvent(frame.sessionKey, frame.event);
    this.options.onOutput?.(frame.sessionKey, output);
    if (output.needsStatsRefresh) this.runStatsRefresh(frame.sessionKey);
    else this.syncStatsRefresh(frame.sessionKey);
  }

  /** 会话关闭：丢掉本地状态与动作，避免视图继续显示上一次的行。 */
  private forgetSession(sessionKey: string): void {
    this.releaseSession(sessionKey);
    useNekStatusStore.getState().removeSession(sessionKey);
  }

  /** 释放某个会话的 feed 侧登记（关闭或 LRU 淘汰都会走这里）。 */
  private releaseSession(sessionKey: string): void {
    this.ownedSessionKeys.delete(sessionKey);
    const timer = this.statsRefreshTimers.get(sessionKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.statsRefreshTimers.delete(sessionKey);
    }
    this.statsRefreshVersions.delete(sessionKey);
    deleteNekStatusActions(sessionKey);
  }

  /** 有界登记：只为最近 `NEK_STATUS_MAX_SESSIONS` 个会话保留动作与清理句柄。 */
  private trackSession(sessionKey: string): void {
    if (this.ownedSessionKeys.has(sessionKey)) {
      this.ownedSessionKeys.delete(sessionKey);
      this.ownedSessionKeys.add(sessionKey);
    } else {
      this.ownedSessionKeys.add(sessionKey);
      while (this.ownedSessionKeys.size > NEK_STATUS_MAX_SESSIONS) {
        const oldest = this.ownedSessionKeys.values().next().value;
        if (oldest === undefined) break;
        this.releaseSession(oldest);
      }
    }
    setNekStatusActions(sessionKey, createActions(this.agentService, this.target, sessionKey));
  }

  /**
   * 被节流挂起（`statsRefreshPending`）的用量刷新：窗口已过就立刻补，否则预约一次尾随刷新，
   * 保证窗口末尾那次刷新不会因为"之后再没有事件"而丢失。
   */
  private syncStatsRefresh(sessionKey: string): void {
    if (this.disposed) return;
    const store = useNekStatusStore.getState();
    if (!store.sessions[sessionKey]?.statsRefreshPending) return;
    if (store.flushStatsRefresh(sessionKey)) {
      this.runStatsRefresh(sessionKey);
      return;
    }
    this.scheduleStatsRefresh(sessionKey);
  }

  private scheduleStatsRefresh(sessionKey: string): void {
    if (this.statsRefreshTimers.has(sessionKey)) return;
    const timer = setTimeout(() => {
      this.statsRefreshTimers.delete(sessionKey);
      if (this.disposed) return;
      this.syncStatsRefresh(sessionKey);
    }, NEK_STATUS_STATS_THROTTLE_MS);
    this.statsRefreshTimers.set(sessionKey, timer);
  }

  private runStatsRefresh(sessionKey: string): void {
    const version = (this.statsRefreshVersions.get(sessionKey) ?? 0) + 1;
    this.statsRefreshVersions.set(sessionKey, version);
    void this.agentService
      .getNekSessionStats(sessionTarget(this.target, sessionKey))
      .then((stats) => {
        // 迟到的用量响应属于旧版本：会话已关闭或已有更新的刷新时丢弃。
        if (this.disposed || this.statsRefreshVersions.get(sessionKey) !== version) return;
        useNekStatusStore.getState().setStats(sessionKey, stats);
      })
      .catch((error: unknown) => {
        // 刷新失败保留上一份用量并把 statsStale 留在 true；下一次事件会按同一节流窗口重试。
        logger.warn("failed to refresh nek status stats", {
          error: error instanceof Error ? error.message : String(error),
          sessionKey,
        });
      });
  }
}

/** 为一个 workspace 建状态 feed；调用方负责 `dispose`（workspace 连接释放时）。 */
export function createNekStatusFeed(
  agentService: NekStatusFeedAgentService,
  target: ZCodeAgentWorkspaceTarget,
  options: NekStatusFeedOptions = {},
): NekStatusFeedHandle {
  const feed = new NekStatusFeed(agentService, target, options);
  feed.start();
  return feed;
}
