import { AsyncButton } from "@/components/ui/async-button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationHistoryControls } from "./useConversationHistoryControls.js";

/** Loading/error feedback never replaces the already readable conversation window. */
export function ConversationHistoryHeader({
  controls,
  navigationError,
}: {
  controls: ConversationHistoryControls;
  navigationError?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const error = navigationError ?? controls.error ?? controls.directory.error;
  const loadingLabel = intl.formatMessage({ id: "chat.message.bodyPreview.loading" });
  return (
    <div className="flex flex-col gap-2 px-4 py-2 text-ui-sm text-foreground-subtle">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {intl.formatMessage(
            { id: "chat.history.loadedTurns" },
            {
              loaded: controls.history.turns.length,
              total: controls.history.totalTurns,
            },
          )}
        </span>
        {controls.history.hasOlder ? (
          <AsyncButton
            variant="ghost"
            size="xs"
            successFeedback="none"
            onClick={controls.loadOlder}
            disabled={controls.loading}
            disabledReason={controls.loading ? loadingLabel : undefined}
          >
            {intl.formatMessage({ id: "chat.history.loadOlderMessages" })}
          </AsyncButton>
        ) : null}
      </div>
      {controls.directoryQuery && controls.directory.hasMore ? (
        <AsyncButton
          variant="ghost"
          size="xs"
          successFeedback="none"
          onClick={controls.directory.loadMore}
        >
          {intl.formatMessage({ id: "chat.history.searchMore" })}
        </AsyncButton>
      ) : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
          <span className="min-w-0 break-words">{error}</span>
          <AsyncButton
            variant="outline"
            size="xs"
            successFeedback="none"
            onClick={controls.directory.error ? controls.directory.reload : controls.retry}
          >
            {intl.formatMessage({ id: "chat.message.bodyPreview.retry" })}
          </AsyncButton>
        </div>
      ) : null}
    </div>
  );
}
