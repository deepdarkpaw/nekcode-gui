import { ArrowLeft, RotateCcw } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useSubagentTranscriptController,
  type SubagentTranscriptControllerProps,
} from "./useSubagentTranscriptController.js";
import { StatusActionButton } from "./viewPrimitives.js";

export type NekSubagentTranscriptViewProps = SubagentTranscriptControllerProps;

function transcriptMessageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message === null) return "null";
  if (message === undefined) return "undefined";
  if (typeof message === "number" || typeof message === "boolean" || typeof message === "bigint") {
    return String(message);
  }
  return JSON.stringify(message);
}

export function NekSubagentTranscriptView(props: NekSubagentTranscriptViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions, onKeyDown } = useSubagentTranscriptController(props);
  const backLabel = intl.formatMessage({ id: "nek.status.transcript.back" });
  const retryLabel = intl.formatMessage({ id: "chat.message.bodyPreview.retry" });
  return (
    <section
      data-status-view="subagent-transcript"
      className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg border border-card-border bg-card p-3"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="flex items-center gap-2">
        <StatusActionButton
          action={actions.back}
          actionId="back"
          label={backLabel}
          variant="outline"
          size="xs"
        >
          <ArrowLeft aria-hidden="true" />
        </StatusActionButton>
        <span className="font-medium text-ui-base text-foreground">{props.id}</span>
        {view.refreshing ? (
          <span className="text-ui-sm text-foreground-subtle" role="status">
            {intl.formatMessage({ id: "chat.message.bodyPreview.loading" })}
          </span>
        ) : null}
      </header>
      {view.refreshError ? (
        <p className="text-ui-sm text-destructive">{view.refreshError}</p>
      ) : null}
      {view.state.status === "loading" ? (
        <p className="text-ui-sm text-foreground-subtle" role="status">
          {intl.formatMessage({ id: "chat.message.bodyPreview.loading" })}
        </p>
      ) : view.state.status === "error" ? (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-ui-sm text-destructive">{view.state.message}</p>
          <StatusActionButton
            action={actions.retry}
            actionId="retry"
            label={retryLabel}
            variant="outline"
            size="xs"
          >
            <RotateCcw aria-hidden="true" />
          </StatusActionButton>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {view.state.truncatedCount > 0 ? (
            <p className="mb-2 text-ui-xs text-foreground-subtle">
              {intl.locale === "zh-CN"
                ? `${view.state.truncatedCount} 条消息已省略`
                : `${view.state.truncatedCount} messages truncated`}
            </p>
          ) : null}
          <ol className="space-y-2">
            {view.state.messages.map((message, index) => (
              <li
                key={`${index}-${transcriptMessageText(message)}`}
                className="whitespace-pre-wrap break-words rounded-md bg-surface px-2 py-1 text-ui-sm text-foreground"
              >
                {transcriptMessageText(message)}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
