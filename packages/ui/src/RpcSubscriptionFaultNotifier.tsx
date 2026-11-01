/**
 * 订阅失败的可见入口（headless）。
 *
 * 渲染层原本没有任何"单条流失败"的界面状态：一条事件流被服务端拒绝后，界面只会一直停在
 * 加载态。这里把 headless store 里的条目接到既有 toast 组件上——持久提示 + 明确的"重试"
 * 动作，不新造组件、不扩展视觉；外观与文案层级由既有 toast 决定。
 *
 * 行为约束：
 * - 每条失败只弹一条提示（`dedupeKey` + `attempt`），用户重试后仍然失败才会再次出现；
 * - 重试走 `fault.retry()`：由 `ChannelClient` 保留原订阅者重新发 EventListen，不是新建空流；
 * - 不自动重试，避免坏 host 上出现热循环。
 */
import { useEffect, useState } from "react";
import { dismissToast, toast } from "@/components/ui/toast.js";
import { createSubscriptionFaultToastPresenter } from "@/lib/rpcSubscriptionFaultToast.js";
import { useZCodeIntl } from "@/i18n/index.js";
import {
  dismissRpcSubscriptionFault,
  retryRpcSubscriptionFault,
  useRpcSubscriptionFaultStore,
} from "@/store/rpcSubscriptionFaultStore.js";

export function RpcSubscriptionFaultNotifier() {
  const { intl } = useZCodeIntl();
  const faults = useRpcSubscriptionFaultStore((state) => state.faults);
  const [presenter] = useState(() =>
    createSubscriptionFaultToastPresenter({
      toast,
      dismissToast,
      retry: retryRpcSubscriptionFault,
      dismissFault: dismissRpcSubscriptionFault,
    }),
  );

  useEffect(() => {
    presenter.sync(faults, {
      title: intl.formatMessage({ id: "ui.rpcSubscription.failed" }),
      retry: intl.formatMessage({ id: "common.retry" }),
      dismiss: intl.formatMessage({ id: "common.close" }),
    });
  }, [faults, intl, presenter]);

  useEffect(() => () => presenter.dispose(), [presenter]);

  return null;
}
