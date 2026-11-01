import type { ToastOptions } from "@/components/ui/toast.js";

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
