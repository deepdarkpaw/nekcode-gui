import type { ToastOptions } from "@/components/ui/toast.js";

type FaultIdentity = { id: string; attempt: number };
type Labels = { title: string; retry: string; dismiss: string };

/** Owns presentation leases only; callbacks resolve live capabilities by identity, never capture one. */
export function createSubscriptionFaultToastPresenter(port: {
  toast(message: string, options: ToastOptions): number;
  dismissToast(id: number): void;
  retry(id: string, attempt: number): void;
  dismissFault(id: string, attempt: number): void;
}) {
  const shown = new Map<string, number>();
  const dispose = (): void => {
    for (const toastId of shown.values()) port.dismissToast(toastId);
    shown.clear();
  };
  return {
    dispose,
    sync(faults: readonly FaultIdentity[], labels: Labels): void {
      const liveKeys = new Set(faults.map((fault) => `${fault.id}#${fault.attempt}`));
      for (const [key, toastId] of shown) {
        if (liveKeys.has(key)) continue;
        port.dismissToast(toastId);
        shown.delete(key);
      }
      for (const { id, attempt } of faults) {
        const key = `${id}#${attempt}`;
        if (shown.has(key)) continue;
        const plan = subscriptionFaultToastPlan(
          { id, attempt },
          labels,
          () => port.retry(id, attempt),
          () => port.dismissFault(id, attempt),
        );
        shown.set(key, port.toast(plan.message, plan.options));
      }
    },
  };
}

/**
 * 一条订阅失败对应的既有 toast 配置。
 *
 * 抽成纯函数便于锁定契约：持久（不自动消失）、带明确重试动作、同一条流用稳定 `dedupeKey`
 * 替换旧提示，`attempt` 让"重试后仍然失败"再提醒一次。
 */
export function subscriptionFaultToastPlan(
  fault: { id: string; attempt: number },
  labels: { title: string; retry: string; dismiss: string },
  onRetry: () => void,
  onDismiss: () => void,
): { message: string; options: ToastOptions } {
  return {
    message: labels.title,
    options: {
      durationMs: 0,
      position: "top-right",
      variant: "warning",
      actionLabel: labels.retry,
      onAction: onRetry,
      onDismiss,
      dismissible: true,
      dismissLabel: labels.dismiss,
      dedupeKey: `rpc-subscription:${fault.id}`,
    },
  };
}
