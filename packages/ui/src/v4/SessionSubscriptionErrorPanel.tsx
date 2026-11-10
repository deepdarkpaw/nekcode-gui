import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface SessionSubscriptionErrorPanelProps {
  /** 订阅失败的原始代码或消息（如 `fault.subscription.recoveryFailed`），作为诊断详情展示。 */
  detail: string | null;
  onReconnect: () => void;
}

/** 与上游共用的连接失败布局：实际错误 + 重新连接，不恢复 GUI 已移除的反馈入口。 */
export function SessionSubscriptionErrorPanel({
  detail,
  onReconnect,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useZCodeIntl();
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base"
    >
      <p className="max-w-full select-text break-words text-center font-mono text-destructive">
        {detail?.trim() || intl.formatMessage({ id: "chat.error.connectionLost" })}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}
