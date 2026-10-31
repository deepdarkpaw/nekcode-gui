import { describe, expect, it, vi } from "vitest";
import { subscriptionFaultToastPlan } from "./lib/rpcSubscriptionFaultToast.js";

const labels = { title: "实时更新已中断", retry: "重试", dismiss: "关闭" };

describe("subscriptionFaultToastPlan", () => {
  it("用既有 toast 呈现持久提示，并带明确重试动作", () => {
    const onRetry = vi.fn();
    const plan = subscriptionFaultToastPlan(
      { id: "a", attempt: 1, retry: vi.fn() },
      labels,
      onRetry,
    );

    expect(plan.message).toBe(labels.title);
    // 0 = 不自动消失：状态问题必须由用户处理，不能几秒后自己消失。
    expect(plan.options.durationMs).toBe(0);
    expect(plan.options.actionLabel).toBe(labels.retry);
    expect(plan.options.dismissible).toBe(true);
    expect(plan.options.variant).toBe("warning");
    // 同一条流的提示互相替换，不会越堆越多。
    expect(plan.options.dedupeKey).toBe("rpc-subscription:a");
    plan.options.onAction?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
