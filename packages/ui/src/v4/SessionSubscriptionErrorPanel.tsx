import type { ReactNode } from "react";
import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

interface SessionRecoveryPanelProps {
  kind: "subscription" | "history";
  detail?: string | null;
  children?: ReactNode;
  onRecover: () => Promise<unknown> | void;
}

/** Upstream centered recovery layout, also used as a compact notice by the history dock. */
export function SessionRecoveryPanel({
  kind,
  detail,
  children,
  onRecover,
}: SessionRecoveryPanelProps) {
  const { intl } = useZCodeIntl();
  const history = kind === "history";
  const reason = detail?.trim();
  const disconnected = !reason || isRemoteWorkspaceDisconnectedError(reason);
  const title = intl.formatMessage({
    id: history
      ? "chat.history.liveIncomplete"
      : disconnected
        ? "chat.error.connectionLost"
        : "chat.error.sessionLoadFailed",
  });
  const action = intl.formatMessage({
    id: history ? "chat.history.reloadHistory" : "workspaceSidebar.reconnect",
  });
  return (
    <section
      aria-label={title}
      data-session-recovery={kind}
      role="alert"
      className={cn(
        "flex min-w-0 flex-col items-center justify-center gap-3 text-center",
        history
          ? "pointer-events-auto mb-2 rounded-xl border border-card-border bg-card px-4 py-3"
          : "flex-1 overflow-auto p-4",
      )}
    >
      <div className="space-y-1">
        <p className="text-ui-base font-medium text-destructive">{title}</p>
        {history ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.history.liveIncompleteHint" })}
          </p>
        ) : null}
      </div>
      <AsyncButton
        type="button"
        size={history ? "sm" : "default"}
        data-testid={history ? undefined : TID_V4_RETRY_SUBSCRIBE}
        aria-label={action}
        successFeedback="none"
        onClick={onRecover}
      >
        {action}
      </AsyncButton>
      {reason || children ? (
        <div className="w-full min-w-0 max-w-xl space-y-1 text-left">
          {reason ? (
            <Fold defaultOpen={false}>
              <FoldTrigger className="mx-auto flex w-fit text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "chat.error.recoveryDetails" })}
              </FoldTrigger>
              <FoldContent>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 font-mono text-ui-sm text-foreground-subtle select-text">
                  {detail}
                </pre>
              </FoldContent>
            </Fold>
          ) : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function SessionSubscriptionErrorPanel({
  detail,
  onReconnect,
}: {
  detail: string | null;
  onReconnect: () => Promise<void> | void;
}) {
  return <SessionRecoveryPanel kind="subscription" detail={detail} onRecover={onReconnect} />;
}
