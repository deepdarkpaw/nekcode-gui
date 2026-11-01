import { describe, expect, it, vi } from "vitest";
import type { ToastOptions } from "./components/ui/toast.js";
import {
  createSubscriptionFaultToastPresenter,
  subscriptionFaultToastPlan,
} from "./lib/rpcSubscriptionFaultToast.js";

const labels = { title: "实时更新已中断", retry: "重试", dismiss: "关闭" };

function presenter() {
  const options: ToastOptions[] = [];
  const toast = vi.fn((_message: string, option: ToastOptions) => options.push(option));
  const dismissToast = vi.fn();
  const retry = vi.fn();
  const dismissFault = vi.fn();
  return {
    controller: createSubscriptionFaultToastPresenter({ toast, dismissToast, retry, dismissFault }),
    options,
    toast,
    dismissToast,
    retry,
    dismissFault,
  };
}

describe("subscription failure presentation specifications", () => {
  it("RPC-UI6: persistent existing toast has independent retry and user-close commands", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const plan = subscriptionFaultToastPlan({ id: "a", attempt: 1 }, labels, onRetry, onDismiss);
    expect(plan.message).toBe(labels.title);
    expect(plan.options.durationMs).toBe(0);
    expect(plan.options.actionLabel).toBe(labels.retry);
    expect(plan.options.dismissible).toBe(true);
    expect(plan.options.variant).toBe("warning");
    expect(plan.options.dedupeKey).toBe("rpc-subscription:a");
    plan.options.onAction?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    plan.options.onDismiss?.();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("RPC-UI7: batched synchronous failure after retry shows attempt 2 instead of suppressing it", () => {
    const view = presenter();
    view.controller.sync([{ id: "a", attempt: 1 }], labels);
    view.options[0]!.onAction?.();
    expect(view.retry).toHaveBeenCalledWith("a", 1);
    // React need only observe the final snapshot, not the transient invalidation/removal.
    view.controller.sync([{ id: "a", attempt: 2 }], labels);
    expect(view.dismissToast).toHaveBeenCalledWith(1);
    expect(view.toast).toHaveBeenCalledTimes(2);
    view.controller.sync([{ id: "a", attempt: 2 }], labels);
    expect(view.toast).toHaveBeenCalledTimes(2);
    view.options[1]!.onDismiss?.();
    expect(view.dismissFault).toHaveBeenCalledWith("a", 2);
    view.controller.sync([], labels);
    expect(view.dismissToast).toHaveBeenCalledWith(2);
  });

  it("RPC-UI8: invalidation, eviction and unmount remove all toast leases; remount restores live state", () => {
    const view = presenter();
    const live = [
      { id: "remote-a", attempt: 1 },
      { id: "base-a", attempt: 1 },
    ];
    view.controller.sync(live, labels);
    view.controller.sync(live.slice(1), labels);
    expect(view.dismissToast.mock.calls).toEqual([[1]]);
    view.controller.dispose();
    expect(view.dismissToast.mock.calls).toEqual([[1], [2]]);
    // Unmount changes presentation only, not the store's live capability list.
    expect(view.dismissFault).not.toHaveBeenCalled();
    view.controller.sync(live.slice(1), labels);
    expect(view.toast).toHaveBeenCalledTimes(3);
    view.controller.dispose();
  });
});
