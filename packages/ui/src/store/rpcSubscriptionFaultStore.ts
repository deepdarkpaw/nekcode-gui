import { create } from "zustand";

/**
 * RPC 订阅失败的可见状态（headless）。
 *
 * 一条事件订阅死掉时，订阅方拿不到任何 terminal 回调，界面只会"永远停在加载态"。这个 store
 * 是连接 owner 与 UI 的唯一交接面：renderer 连接把 `IChannelSubscriptionFailure` 映射成条目，
 * UI 只负责按条目弹既有提示并调用 `retry()`（重新建立同一条订阅，而不是新建一个没人监听的
 * emitter）。
 *
 * 表格有界：同一 (channel, event) 只保留一条，并最多保留 `MAX_RPC_SUBSCRIPTION_FAULTS` 条，
 * 避免一个坏 host 把所有流都失败时把内存和提示栈堆爆。
 */
export const MAX_RPC_SUBSCRIPTION_FAULTS = 8;

interface RpcSubscriptionFault {
  /** 稳定键：同一 channel + event 视为同一条流。 */
  id: string;
  channelName: string;
  event: string;
  /** 第几次失败；提示层用它区分"用户重试后仍然失败"。 */
  attempt: number;
  /** 重新建立同一条订阅（由 ChannelClient 保留的订阅者决定）。 */
  retry(): void;
}

interface RpcSubscriptionFaultState {
  faults: RpcSubscriptionFault[];
  upsert(fault: Omit<RpcSubscriptionFault, "attempt">): void;
  dismiss(id: string): void;
  clear(): void;
}

export const useRpcSubscriptionFaultStore = create<RpcSubscriptionFaultState>()((set) => ({
  faults: [],
  upsert: (fault) =>
    set((state) => {
      const previous = state.faults.find((current) => current.id === fault.id);
      const next: RpcSubscriptionFault = {
        ...fault,
        attempt: (previous?.attempt ?? 0) + 1,
      };
      const others = state.faults.filter((current) => current.id !== fault.id);
      return { faults: [...others, next].slice(-MAX_RPC_SUBSCRIPTION_FAULTS) };
    }),
  dismiss: (id) =>
    set((state) => ({ faults: state.faults.filter((current) => current.id !== id) })),
  clear: () => set({ faults: [] }),
}));

/** 订阅失败入口：连接 owner 调用；同一 (channel, event) 只提升 attempt。 */
export function registerRpcSubscriptionFault(fault: Omit<RpcSubscriptionFault, "attempt">): void {
  useRpcSubscriptionFaultStore.getState().upsert(fault);
}

/** 提示被处理（重试/关闭）或订阅恢复后移除条目。 */
export function dismissRpcSubscriptionFault(id: string): void {
  useRpcSubscriptionFaultStore.getState().dismiss(id);
}

export function clearRpcSubscriptionFaults(): void {
  useRpcSubscriptionFaultStore.getState().clear();
}
