import type { LiveHistoryPreview } from "@zcode/shared/zcode-protocol-v4";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/lib/displayFormat.js";

/** A raw transport excerpt is never rendered as Markdown or as a completed semantic result. */
export function ConversationLiveHistoryNotice({
  preview,
  error,
  reload,
}: {
  preview?: LiveHistoryPreview | null;
  error?: string;
  reload: () => Promise<unknown>;
}) {
  const { intl } = useZCodeIntl();
  if (!preview && !error) return null;
  return (
    <section
      role="alert"
      className="mx-4 my-2 space-y-2 rounded-lg border border-card-border bg-card p-3 text-ui-sm"
    >
      <p className="font-medium text-warning">
        {intl.formatMessage({ id: "chat.history.liveIncomplete" })}
      </p>
      <p className="text-foreground-subtle">
        {intl.formatMessage({ id: "chat.history.liveIncompleteHint" })}
      </p>
      {error ? <p className="select-text break-words text-destructive">{error}</p> : null}
      {preview ? (
        <Fold key={`${preview.epoch}:${preview.eventId}`} defaultOpen={false}>
          <FoldTrigger className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.history.rawPreview" },
              { size: formatBytes(preview.receivedBytes) },
            )}
          </FoldTrigger>
          <FoldContent>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-ui-xs">
              {preview.preview}
            </pre>
          </FoldContent>
        </Fold>
      ) : null}
      <AsyncButton size="sm" variant="outline" successFeedback="none" onClick={reload}>
        {intl.formatMessage({ id: "chat.history.reloadHistory" })}
      </AsyncButton>
    </section>
  );
}
