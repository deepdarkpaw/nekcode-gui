import { ArrowUpIcon } from "lucide-react";
import { AsyncButton } from "@/components/ui/async-button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationHistoryControls } from "./useConversationHistoryControls.js";

/** Turns that exist before the first loaded turn; positions are zero-based source turn indexes. */
export function olderTurnCount(history: ConversationHistoryControls["history"]): number {
  const first = history.turns[0];
  return first ? first.position : 0;
}

/**
 * Top of the loaded window: one centered button prepends the previous page of complete turns.
 * Loading/error feedback never replaces the already readable conversation window.
 */
export function ConversationHistoryHeader({
  controls,
  onLoadOlder,
  navigationError,
  selectionOnly = false,
}: {
  controls: ConversationHistoryControls;
  /** Timeline wrapper that keeps the current reading position anchored across the prepend. */
  onLoadOlder?: () => Promise<void>;
  navigationError?: string | null;
  selectionOnly?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const error = navigationError ?? controls.error ?? controls.directory.error;
  const loadingLabel = intl.formatMessage({ id: "chat.message.bodyPreview.loading" });
  const remaining = olderTurnCount(controls.history);
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-3 text-ui-sm text-foreground-subtle">
      {controls.history.hasOlder ? (
        <AsyncButton
          variant="outline"
          size="sm"
          successFeedback="none"
          icon={<ArrowUpIcon />}
          onClick={onLoadOlder ?? controls.loadOlder}
          disabled={controls.loading}
          disabledReason={controls.loading ? loadingLabel : undefined}
        >
          {remaining > 0
            ? intl.formatMessage({ id: "chat.history.loadOlderTurns" }, { count: remaining })
            : intl.formatMessage({ id: "chat.history.loadOlderMessages" })}
        </AsyncButton>
      ) : null}
      {selectionOnly ? (
        <p className="text-center">{intl.formatMessage({ id: "chat.history.shareSelectionOnly" })}</p>
      ) : null}
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
        <div role="alert" className="flex flex-wrap items-center justify-center gap-2 text-destructive">
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
