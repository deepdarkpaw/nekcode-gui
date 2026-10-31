/**
 * 把 nek 的会话进程事实投影成 workspace 级 runtime 生命周期。
 *
 * `IZCodeAgentService.onAgentRuntimeLifecycle` 是渲染层与 host 观察者判断“runtime 换代”的
 * 唯一被动信号：unavailable 到达时立刻作废旧订阅、重建草稿会话；available 负责唤醒 dormant
 * 的 sessions-index 观察者（`zcodeTaskIndexSyncer`、`windowHostSessionsIndexObserver` 在
 * 没有 lifecycle 时才回退到 `onAgentRuntimeRestarted`，两者语义并不等价）。
 *
 * 这个方法名本身就是 RPC 事件名：nek adapter 若不提供它，渲染层订阅会在 host 侧抛
 * `Event not found`，因此不能省略，也不能返回一个永不触发的事件（dormant 观察者会永久休眠）。
 */
import type { IDisposable } from "@zcode/rpc";
import type { ZCodeAgentRuntimeLifecycleEvent } from "../../zcode-agent/zcodeAgent.js";
import type { NekAgentServiceEvent } from "../service/types.js";
import { workspaceKey } from "./frameHelpers.js";

/** 代际表只保留最近用过的 workspace；超出后淘汰最旧条目，保持有界。 */
export const NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES = 64;

interface WorkspaceRuntimeCursor {
  /** 与 `getWorkspaceRuntimeIdentity` 的初值对齐：nek 没有 CLI 换代概念，从 1 开始自增。 */
  generation: number;
  /** 已发过 unavailable 且尚未观察到新 runtime。 */
  unavailable: boolean;
}

type RuntimeLifecycleListener = (event: ZCodeAgentRuntimeLifecycleEvent) => void;

export interface NekRuntimeLifecycleSource {
  onEvent(listener: (event: NekAgentServiceEvent) => void): () => void;
}

export function createNekAgentRuntimeLifecycle(
  service: NekRuntimeLifecycleSource,
): (listener: RuntimeLifecycleListener) => IDisposable {
  const cursors = new Map<string, WorkspaceRuntimeCursor>();

  const cursorFor = (key: string): WorkspaceRuntimeCursor => {
    const existing = cursors.get(key);
    if (existing) return existing;
    if (cursors.size >= NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES) {
      const oldest = cursors.keys().next();
      if (!oldest.done) cursors.delete(oldest.value);
    }
    const created: WorkspaceRuntimeCursor = { generation: 1, unavailable: false };
    cursors.set(key, created);
    return created;
  };

  const emit = (
    listener: RuntimeLifecycleListener,
    cursor: WorkspaceRuntimeCursor,
    workspacePath: string,
    key: string,
    state: "available" | "unavailable",
  ): void => {
    listener({
      workspacePath,
      workspaceKey: key,
      runtimeIdentity: {
        generation: cursor.generation,
        identity: `nek:${key}`,
        workspaceKey: key,
      },
      state,
    });
  };

  const publish = (listener: RuntimeLifecycleListener, event: NekAgentServiceEvent): void => {
    const workspacePath = event.session.cwd;
    const key = workspaceKey({ workspacePath });
    const cursor = cursorFor(key);
    if (event.type === "process_exit") {
      cursor.unavailable = true;
      emit(listener, cursor, workspacePath, key, "unavailable");
      return;
    }
    // 会话进程重新可用（崩溃后重启、或重新打开会话）才算新一代 runtime。
    // 存活期间的 running/idle 抖动不是换代，重复发 available 会让观察者反复重订阅。
    if (event.type !== "state" || !cursor.unavailable) return;
    if (event.state === "error" || event.state === "locked") return;
    cursor.unavailable = false;
    cursor.generation += 1;
    emit(listener, cursor, workspacePath, key, "available");
  };

  return (listener) => {
    const detach = service.onEvent((event) => publish(listener, event));
    return { dispose: detach };
  };
}
