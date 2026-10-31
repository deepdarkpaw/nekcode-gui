import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RPC_SUBSCRIPTION_FAULTS,
  clearRpcSubscriptionFaults,
  dismissRpcSubscriptionFault,
  registerRpcSubscriptionFault,
  useRpcSubscriptionFaultStore,
} from "./rpcSubscriptionFaultStore.js";

const fault = (id: string, retry: () => void = () => undefined) => ({
  id,
  channelName: "zcode-agent",
  event: "onAgentRuntimeLifecycle",
  retry,
});

const read = () => useRpcSubscriptionFaultStore.getState().faults;

describe("rpcSubscriptionFaultStore", () => {
  beforeEach(() => clearRpcSubscriptionFaults());

  it("同一 (channel, event) 只保留一条，并提升 attempt", () => {
    registerRpcSubscriptionFault(fault("a"));
    registerRpcSubscriptionFault(fault("a"));
    expect(read().map((item) => [item.id, item.attempt])).toEqual([["a", 2]]);
  });

  it("最多保留上限条，旧条目先淘汰", () => {
    for (let index = 0; index < MAX_RPC_SUBSCRIPTION_FAULTS + 3; index += 1) {
      registerRpcSubscriptionFault(fault(`f${index}`));
    }
    const ids = read().map((item) => item.id);
    expect(ids).toHaveLength(MAX_RPC_SUBSCRIPTION_FAULTS);
    expect(ids).not.toContain("f0");
    expect(ids.at(-1)).toBe(`f${MAX_RPC_SUBSCRIPTION_FAULTS + 2}`);
  });

  it("保留重试句柄，dismiss 后移除", () => {
    const retry = vi.fn();
    registerRpcSubscriptionFault(fault("a", retry));
    read()[0]!.retry();
    expect(retry).toHaveBeenCalledTimes(1);
    dismissRpcSubscriptionFault("a");
    expect(read()).toEqual([]);
  });
});
