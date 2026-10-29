import { FileText, Square } from "lucide-react";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useSubagentCardController,
  type SubagentCardControllerProps,
} from "./useSubagentCardController.js";
import { StatusActionButton, renderStatusMessage, statusToneClass } from "./viewPrimitives.js";

export type NekSubagentCardViewProps = SubagentCardControllerProps;

export function NekSubagentCardView(props: NekSubagentCardViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions, onKeyDown } = useSubagentCardController(props);
  if (!view.visible) return null;
  const status = intl.formatMessage({ id: view.statusId });
  const body = view.body?.text ?? renderStatusMessage(intl, view.body?.message);
  const stopLabel = intl.formatMessage({ id: "nek.status.subagent.stop" });
  const stopNamedLabel = intl.formatMessage(
    { id: "nek.status.subagent.stopNamed" },
    { description: view.title },
  );
  // The locale bundle predates the transcript action key; this existing message is the closest
  // shared label for opening the complete child-agent record.
  const transcriptLabel = intl.formatMessage({ id: "chat.message.bodyPreview.loadFull" });
  return (
    <Fold
      open={view.fold.open}
      onOpenChange={view.fold.onOpenChange}
      focusable
      onKeyDown={onKeyDown}
      className="rounded-lg border border-card-border bg-card px-3 py-2"
      data-status-view="subagent-card"
      data-subagent-id={props.id}
    >
      <div className="flex min-w-0 items-start gap-2">
        <FoldTrigger chevron="end" className="min-w-0 flex-1 flex-wrap gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-medium text-foreground">{view.title}</span>
          <span className={`rounded px-1.5 py-0.5 text-ui-xs ${statusToneClass(view.tone)}`}>
            {status}
          </span>
          {view.background ? (
            <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "nek.status.subagent.background" })}
            </span>
          ) : null}
          <span className="basis-full truncate text-ui-sm text-foreground-subtle">
            {view.metaParts.join(" · ")}
          </span>
        </FoldTrigger>
        <StatusActionButton
          action={actions.stop}
          actionId="stop"
          label={stopLabel}
          ariaLabel={stopNamedLabel}
          variant="destructive"
          size="xs"
        >
          <Square aria-hidden="true" />
        </StatusActionButton>
      </div>
      {view.activity ? (
        <p className="mt-1 truncate text-ui-sm text-foreground-subtle" title={view.activity}>
          {view.activity}
        </p>
      ) : null}
      <FoldContent className="pt-2">
        {body ? (
          <p className="whitespace-pre-wrap break-words text-ui-sm text-foreground">{body}</p>
        ) : null}
        <StatusActionButton
          action={actions.openTranscript}
          actionId="openTranscript"
          label={transcriptLabel}
          variant="outline"
          size="xs"
        >
          <FileText aria-hidden="true" />
        </StatusActionButton>
      </FoldContent>
    </Fold>
  );
}
