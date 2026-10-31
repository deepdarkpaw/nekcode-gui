/**
 * nek 会话进程事实 → workspace 级 runtime 生命周期（观察者恢复代际）。
 *
 * `IZCodeAgentService.onAgentRuntimeLifecycle` 是渲染层与 host 观察者判断“runtime 换代”的
 * 唯一被动信号：unavailable 到达时立刻作废旧订阅、重建草稿会话；available 负责唤醒 dormant
 * 的 sessions-index 观察者（`zcodeTaskIndexSyncer`、`windowHostSessionsIndexObserver` 在
 * 没有 lifecycle 时才回退到 `onAgentRuntimeRestarted`，两者语义并不等价）。
 *
 * 这个信号是**用于观察者恢复的代际**，不是“workspace 是否存在”的镜像：
 *
 * - 正常关闭最后一个会话、空闲/容量回收都不会发 `unavailable`：host 侧的订阅仍然有效，
 *   帧流不会断，观察者不需要换代。`unavailable` 只用于**错误恢复**——该 workspace 的最后
 *   一条会话进程非正常退出。
 * - nek 每个打开的会话一个进程，一个 workspace 可能同时有多个会话。只要还有任意一个挂接
 *   进程的会话，单个会话崩溃就不改写 workspace 代际（否则会误伤仍然有效的订阅）。
 * - `available` 只由 `process_attached` 触发：新会话、恢复会话、回收后重连都会挂进程。
 *   phase 抖动（idle/running/waiting_input/error/locked）不是生命周期事实，与
 *   closing/closed/starting 一样一律忽略——用 phase 反推恢复会在“新会话从 idle 开始、
 *   setPhase 见值相同不发事件”时让观察者永久休眠。
 * - 代际是**全局单调票据**：每次新建 workspace 记忆、以及每次从 unavailable 恢复，都从同一个
 *   计数器领取一个更大的号。观察者只做相等比较，所以即使代际表因有界而淘汰过某个 workspace，
 *   它重新出现时拿到的号也一定比历史值大——代际永不回退，旧代不会被误判成新代。
 * - 回收边界：表满时优先淘汰“没有存活进程”的记忆（`published !== "available"`），
 *   活跃 workspace 最后才被淘汰；两条路径都不改变代际单调性。
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

/** 代际表只保留最近用过的 workspace；超出后按回收边界淘汰，保持有界。 */
export const NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES = 64;

type RuntimeLifecycleListener = (event: ZCodeAgentRuntimeLifecycleEvent) => void;
type PublishedRuntimeState = "available" | "unavailable";

interface WorkspaceRuntimeCursor {
  /** 最近一代 runtime 的全局单调票据；首个 runtime 与 identity 查询共用同一个号。 */
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
  /** 与事件共用同一份代际记忆；不会制造事件。 */
  getIdentity(workspacePath: string): ZCodeAgentWorkspaceRuntimeIdentity;
  dispose(): void;
}

export function createNekAgentRuntimeLifecycle(
  service: NekRuntimeLifecycleSource,
): NekAgentRuntimeLifecycle {
  const cursors = new Map<string, WorkspaceRuntimeCursor>();
  const listeners = new Set<RuntimeLifecycleListener>();
  let nextGeneration = 1;
  let disposed = false;

  /** 领取一个比历史值都大的代际票据。 */
  const takeGeneration = (): number => nextGeneration++;

  /**
   * 表满时的回收边界：先淘汰没有存活进程的记忆（LRU 序里最早的那条），活跃 workspace 最后
   * 才被淘汰。淘汰只丢记忆——代际票据全局单调，重建时不会回退，因此两条路径都安全。
   */
  const evictOne = (): void => {
    let fallback: string | undefined;
    for (const [key, cursor] of cursors) {
      fallback ??= key;
      if (cursor.published === "available") continue;
      cursors.delete(key);
      return;
    }
    if (fallback !== undefined) cursors.delete(fallback);
  };

  /** 取该 workspace 的记忆并按最近使用排序（Map 插入序即 LRU 序）。 */
  const cursorFor = (key: string): WorkspaceRuntimeCursor => {
    const existing = cursors.get(key);
    if (existing) {
      cursors.delete(key);
      cursors.set(key, existing);
      return existing;
    }
    if (cursors.size >= NEK_RUNTIME_LIFECYCLE_MAX_WORKSPACES) evictOne();
    const created: WorkspaceRuntimeCursor = { generation: takeGeneration(), published: null };
    cursors.set(key, created);
    return created;
  };

  const identityOf = (
    key: string,
    cursor: WorkspaceRuntimeCursor,
  ): ZCodeAgentWorkspaceRuntimeIdentity => ({
    generation: cursor.generation,
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
    // 首个 runtime 沿用 identity 已领到的票据；错误恢复后才是新一代。
    if (cursor.published === "unavailable") cursor.generation = takeGeneration();
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
    getIdentity: (workspacePath) => {
      const key = workspaceKey({ workspacePath });
      const cursor = cursors.get(key);
      // 还没出现过任何进程事实：预留一个票据，保证随后首个 available 与这次查询一致。
      if (!cursor) return identityOf(key, cursorFor(key));
      // 已存在：只记访问顺序，不领新号。
      cursors.delete(key);
      cursors.set(key, cursor);
      return identityOf(key, cursor);
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
