import { create } from "zustand";
import type { IChannelSubscriptionFailure } from "@zcode/rpc";

export const MAX_RPC_SUBSCRIPTION_FAULTS = 8;

interface RpcSubscriptionFault {
  /** Connection + logical subscription identity and RPC-owned attempt, not event names. */
  id: string;
  attempt: number;
  channelName: string;
  event: string;
  retry(): void;
  /** Releases only the invalidation observer, never the business subscription. */
  release(): void;
}

interface RpcSubscriptionFaultState {
  faults: RpcSubscriptionFault[];
  upsert(fault: RpcSubscriptionFault): void;
  dismiss(id: string, attempt?: number): void;
  clear(): void;
}

/** Bounded projection of revocable RPC capabilities; no second retry counter or connection owner. */
export const useRpcSubscriptionFaultStore = create<RpcSubscriptionFaultState>()((set) => ({
  faults: [],
  upsert: (fault) =>
    set((state) => {
      const others = state.faults.filter((current) => current.id !== fault.id);
      const next = [...others, fault].slice(-MAX_RPC_SUBSCRIPTION_FAULTS);
      for (const previous of state.faults) {
        if (!next.includes(previous)) previous.release();
      }
      return { faults: next };
    }),
  dismiss: (id, attempt) =>
    set((state) => ({
      faults: state.faults.filter((fault) => {
        if (fault.id !== id || (attempt !== undefined && fault.attempt !== attempt)) return true;
        fault.release();
        return false;
      }),
    })),
  clear: () =>
    set((state) => {
      for (const fault of state.faults) fault.release();
      return { faults: [] };
    }),
}));

/** The capability invalidates on retry, last unsubscribe, or connection disposal, even without React. */
export function registerRpcSubscriptionFault(failure: IChannelSubscriptionFailure): void {
  if (!failure.isLive()) return;
  const { id, attempt, channelName, event } = failure;
  const observer = failure.onDidInvalidate(() => dismissRpcSubscriptionFault(id, attempt));
  useRpcSubscriptionFaultStore.getState().upsert({
    id,
    attempt,
    channelName,
    event,
    retry: failure.retry,
    release: () => observer.dispose(),
  });
}

/** A stale toast cannot retry or dismiss a newer failure of the same stream. */
export function retryRpcSubscriptionFault(id: string, attempt: number): void {
  useRpcSubscriptionFaultStore
    .getState()
    .faults.find((fault) => fault.id === id && fault.attempt === attempt)
    ?.retry();
}

export function dismissRpcSubscriptionFault(id: string, attempt?: number): void {
  useRpcSubscriptionFaultStore.getState().dismiss(id, attempt);
}

export function clearRpcSubscriptionFaults(): void {
  useRpcSubscriptionFaultStore.getState().clear();
}
