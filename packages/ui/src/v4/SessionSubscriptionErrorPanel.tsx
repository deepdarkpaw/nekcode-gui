import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface SessionSubscriptionErrorPanelProps {
  /** 订阅失败的原始代码或消息（如 `fault.subscription.recoveryFailed`），作为诊断详情展示。 */
  detail: string | null;
  onReconnect: () => void;
}

/** 会话订阅失败：本地化标题 + 可选中的原始详情 + 重新连接。原始代码不作为正文。 */
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
      <p className="text-center font-medium text-destructive">
        {intl.formatMessage({ id: "chat.error.sessionLoadFailed" })}
      </p>
      {detail ? (
        <p className="max-w-full select-text break-words text-center font-mono text-ui-sm text-muted-foreground">
          {detail}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}
