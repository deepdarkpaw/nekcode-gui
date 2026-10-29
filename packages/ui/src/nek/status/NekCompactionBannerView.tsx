import { X } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useCompactionController,
  type CompactionControllerProps,
} from "./useCompactionController.js";
import { StatusActionButton, statusMessageText } from "./viewPrimitives.js";

export type NekCompactionBannerViewProps = CompactionControllerProps;

export function NekCompactionBannerView(props: NekCompactionBannerViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions, onKeyDown } = useCompactionController(props);
  if (!view.visible) return null;
  const message = view.message ? statusMessageText(intl, view.message) : undefined;
  const cancelLabel = intl.formatMessage({ id: "nek.status.compaction.cancel" });
  const dismissLabel = intl.formatMessage({ id: "common.close" });
  return (
    <section
      data-status-view="compaction-banner"
      className="flex min-w-0 items-center gap-2 rounded-lg border border-card-border bg-surface px-3 py-2"
      role={view.phase === "failed" ? "alert" : "status"}
      onKeyDown={onKeyDown}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui-sm text-foreground">
          {message ?? view.error ?? intl.formatMessage({ id: "common.loading" })}
        </p>
        {view.elapsed ? (
          <span className="text-ui-xs text-foreground-subtle">{view.elapsed}</span>
        ) : null}
        {view.error ? <p className="mt-1 text-ui-sm text-destructive">{view.error}</p> : null}
        {view.notice ? (
          <p className="mt-1 text-ui-sm text-success">{statusMessageText(intl, view.notice)}</p>
        ) : null}
      </div>
      <StatusActionButton
        action={actions.cancelCompaction}
        actionId="cancelCompaction"
        label={cancelLabel}
        variant="warning"
        size="xs"
      />
      <StatusActionButton
        action={actions.dismiss}
        actionId="dismiss"
        label={dismissLabel}
        variant="ghost"
        size="xs"
      >
        <X aria-hidden="true" />
      </StatusActionButton>
    </section>
  );
}
