import { X } from "lucide-react";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useRetryBannerController,
  type RetryBannerControllerProps,
} from "./useRetryBannerController.js";
import { StatusActionButton, statusMessageText } from "./viewPrimitives.js";

export type NekRetryBannerViewProps = RetryBannerControllerProps;

export function NekRetryBannerView(props: NekRetryBannerViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions, onKeyDown } = useRetryBannerController(props);
  if (!view.visible || !view.message) return null;
  const retryMessage = statusMessageText(intl, view.message);
  const message =
    view.kind === "summarization"
      ? `${intl.formatMessage({ id: "nek.status.retry.summarizationPrefix" })}${retryMessage}`
      : retryMessage;
  const cancelLabel = intl.formatMessage({ id: "nek.status.retry.cancel" });
  const dismissLabel = intl.formatMessage({ id: "nek.status.retry.dismiss" });
  return (
    <section
      data-status-view="retry-banner"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
      role="status"
      onKeyDown={onKeyDown}
    >
      <div className="min-w-0 flex-1">
        <p className="text-ui-sm text-foreground">{message}</p>
        {view.errorSummary ? (
          <Fold defaultOpen={false} className="mt-1">
            <FoldTrigger chevron="end" className="text-ui-sm text-foreground-subtle">
              {view.errorSummary}
            </FoldTrigger>
            {view.errorDetail ? (
              <FoldContent className="pt-1">
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-ui-sm text-foreground-subtle">
                  {view.errorDetail}
                </pre>
              </FoldContent>
            ) : null}
          </Fold>
        ) : null}
      </div>
      <StatusActionButton
        action={actions.cancelRetry}
        actionId="cancelRetry"
        label={cancelLabel}
        variant="ghost"
        size="sm"
      />
      <StatusActionButton
        action={actions.dismiss}
        actionId="dismiss"
        label={dismissLabel}
        variant="ghost"
        size="sm"
      >
        <X aria-hidden="true" className="size-4 shrink-0" />
      </StatusActionButton>
    </section>
  );
}
