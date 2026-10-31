/**
 * nek 会话进程事实 → workspace 级 runtime 生命周期。
 *
 * `IZCodeAgentService.onAgentRuntimeLifecycle` 是渲染层与 host 观察者判断“runtime 换代”的
 * 唯一被动信号：unavailable 到达时立刻作废旧订阅、重建草稿会话；available 负责唤醒 dormant
 * 的 sessions-index 观察者（`zcodeTaskIndexSyncer`、`windowHostSessionsIndexObserver` 在
 * 没有 lifecycle 时才回退到 `onAgentRuntimeRestarted`，两者语义并不等价）。
 *
 * 语义（唯一 owner = 本模块；会话进程的真相仍由 `NekAgentService` 的记录表回答）：
 *
 * - nek 每个打开的会话一个进程，一个 workspace 里可能同时有多个会话。workspace runtime 存在
 *   当且仅当该 workspace 还有任意一个挂接进程的会话，因此**单个会话关闭或崩溃都不构成
 *   workspace 不可用**；只有最后一条存活进程消失才发 unavailable。
 * - unavailable 只由非正常退出触发（服务层对主动关闭不发 `process_exit`）。正常关闭、
 *   空闲/容量回收都不是故障，不制造换代，避免观察者丢掉仍然有效的订阅。
 * - available 只由 `process_attached` 触发：新会话、恢复会话、回收后重连都会挂进程。
 *   phase 抖动（idle/running/waiting_input/error/locked）不是生命周期事实，与
 *   closing/closed/starting 一样一律忽略——用 phase 反推恢复会在“新会话从 idle 开始、
 *   setPhase 见值相同不发事件”时让观察者永久休眠。
 * - 代际只在“不可用 → 重新可用”时自增：unavailable 携带刚失效的那一代，随后的
 *   available 才是新代。代际初值 1 同时是 `getWorkspaceRuntimeIdentity` 在首个进程出现
 *   之前的答案，两者共用同一份记忆。
 * - 订阅者共享一次计算：一个服务订阅、一次状态转移、广播给全部监听者。没有监听者时也
 *   继续记账（观察者可能稍后才订阅，代际不能因此漂移）。
 */
import type { Event } from "@zcode/rpc";
import type {
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceRuntimeIdentity,
} from "../../zcode-agent/zcodeAgent.js";
import type { NekAgentServiceEvent } from "../service/types.js";
import { workspaceKey } from "./frameHelpers.js";

/** 代际表只保留最近用过的 workspace；超出后淘汰最旧条目，保持有界。 */
export const NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES = 64;

type RuntimeLifecycleListener = (event: ZCodeAgentRuntimeLifecycleEvent) => void;
type PublishedRuntimeState = "available" | "unavailable";

interface WorkspaceRuntimeCursor {
  /** 最近一代 runtime 的编号；首个 runtime 为 1。 */
  generation: number;
  /** 已广播的状态；null = 该 workspace 还没有任何进程事实。 */
  published: PublishedRuntimeState | null;
}

export interface NekRuntimeLifecycleSource {
  onEvent(listener: (event: NekAgentServiceEvent) => void): () => void;
  /** workspace 是否还有挂接进程的会话；由会话记录表的 owner 回答。 */
  hasLiveSessionProcess(workspacePath: string): boolean;
}

/** 返回值形状：只有本模块导出实例，消费者按结构使用，不需要再导出这个类型。 */
interface NekAgentRuntimeLifecycle {
  /** 被动观察签名；同一事实只计算一次并广播给所有监听者。 */
  readonly onDidChange: Event<ZCodeAgentRuntimeLifecycleEvent>;
  /** 与事件共用同一份代际记忆；无副作用，也不会制造事件。 */
  getIdentity(workspacePath: string): ZCodeAgentWorkspaceRuntimeIdentity;
  dispose(): void;
}

export function createNekAgentRuntimeLifecycle(
  service: NekRuntimeLifecycleSource,
): NekAgentRuntimeLifecycle {
  const cursors = new Map<string, WorkspaceRuntimeCursor>();
  const listeners = new Set<RuntimeLifecycleListener>();
  let disposed = false;

  /** 取该 workspace 的记忆并按最近使用排序（Map 插入序即 LRU 序）。 */
  const cursorFor = (key: string): WorkspaceRuntimeCursor => {
    const existing = cursors.get(key);
    if (existing) {
      cursors.delete(key);
      cursors.set(key, existing);
      return existing;
    }
    if (cursors.size >= NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES) {
      const oldest = cursors.keys().next();
      if (!oldest.done) cursors.delete(oldest.value);
    }
    const created: WorkspaceRuntimeCursor = { generation: 1, published: null };
    cursors.set(key, created);
    return created;
  };

  const identityOf = (
    key: string,
    cursor: WorkspaceRuntimeCursor | undefined,
  ): ZCodeAgentWorkspaceRuntimeIdentity => ({
    // 没有记忆 = 该 workspace 还没出现过任何进程事实，代际就是初值。
    generation: cursor?.generation ?? 1,
    identity: `nek:${key}`,
    workspaceKey: key,
  });

  /**
   * 一个监听者抛错不能让其余监听者漏帧，也不能把异常吞掉：逐个调用后把首个异常交回
   * 服务层的事件分发（`NekAgentService.emit` 会连同 logger 记录），其余监听者照常收到。
   */
  const broadcast = (event: ZCodeAgentRuntimeLifecycleEvent): void => {
    let failure: unknown;
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  };

  /**
   * 用权威存活事实把 workspace 记忆推进到该有的状态。
   *
   * 只有状态真的变化才广播；重复事实（存活期间抖动、同一断代里第二个会话也退出）
   * 不产生事件，观察者不会反复重订阅。
   */
  const reconcile = (workspacePath: string): void => {
    const key = workspaceKey({ workspacePath });
    const cursor = cursorFor(key);
    if (!service.hasLiveSessionProcess(workspacePath)) {
      if (cursor.published === "unavailable") return;
      cursor.published = "unavailable";
      broadcast({
        workspacePath,
        workspaceKey: key,
        runtimeIdentity: identityOf(key, cursor),
        state: "unavailable",
      });
      return;
    }
    if (cursor.published === "available") return;
    if (cursor.published === "unavailable") cursor.generation += 1;
    cursor.published = "available";
    broadcast({
      workspacePath,
      workspaceKey: key,
      runtimeIdentity: identityOf(key, cursor),
      state: "available",
    });
  };

  const detach = service.onEvent((event) => {
    if (event.type !== "process_attached" && event.type !== "process_exit") return;
    reconcile(event.session.cwd);
  });

  return {
    onDidChange: (listener) => {
      if (disposed) return { dispose: () => undefined };
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    // 只读：查询不能改变 LRU 顺序，也不能替一个冷 workspace 抢占代际表位置。
    getIdentity: (workspacePath) => {
      const key = workspaceKey({ workspacePath });
      return identityOf(key, cursors.get(key));
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      detach();
      listeners.clear();
      cursors.clear();
    },
  };
}
