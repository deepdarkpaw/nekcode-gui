import type { LiveHistoryPreview } from "@zcode/shared/zcode-protocol-v4";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/lib/displayFormat.js";
import { SessionRecoveryPanel } from "./SessionSubscriptionErrorPanel.js";

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
  const recover = async () => {
    try {
      await reload();
    } catch (failure) {
      if (failure instanceof Error && /^RECOVERY_ACTIVE(?:$|:)/.test(failure.message)) {
        throw new Error(intl.formatMessage({ id: "chat.history.recoveryActive" }), {
          cause: failure,
        });
      }
      throw failure;
    }
  };
  return (
    <SessionRecoveryPanel kind="history" detail={error} onRecover={recover}>
      {preview ? (
        <Fold key={`${preview.epoch}:${preview.eventId}`} defaultOpen={false}>
          <FoldTrigger className="mx-auto flex w-fit text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.history.rawPreview" },
              { size: formatBytes(preview.receivedBytes) },
            )}
          </FoldTrigger>
          <FoldContent>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 font-mono text-ui-sm text-foreground-subtle select-text">
              {preview.preview}
            </pre>
          </FoldContent>
        </Fold>
      ) : null}
    </SessionRecoveryPanel>
  );
}
