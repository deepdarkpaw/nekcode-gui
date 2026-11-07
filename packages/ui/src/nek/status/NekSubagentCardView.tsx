import { Square } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useSubagentCardController,
  type SubagentCardControllerProps,
} from "./useSubagentCardController.js";
import { StatusActionButton, renderStatusMessage, statusToneClass } from "./viewPrimitives.js";

export type NekSubagentCardViewProps = SubagentCardControllerProps;

/** 状态与跳转入口；正文只在右侧标准对话预览展示，不在状态槽重复一份原始回复。 */
export function NekSubagentCardView(props: NekSubagentCardViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions } = useSubagentCardController(props);
  if (!view.visible) return null;
  const body = view.body?.text ?? renderStatusMessage(intl, view.body?.message);
  return (
    <section
      className="rounded-lg border border-card-border bg-card px-3 py-2"
      data-status-view="subagent-card"
      data-subagent-id={props.id}
    >
      <div className="flex min-w-0 items-start gap-2">
        <Button
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start px-0 py-0 text-left"
          disabled={!actions.openTranscript.enabled}
          onClick={() => void actions.openTranscript.run()}
          aria-label={intl.formatMessage(
            { id: "nek.status.subagent.openPreview" },
            { description: view.title },
          )}
        >
          <span className="min-w-0 truncate font-medium">{view.title}</span>
        </Button>
        <span className={`rounded px-1.5 py-0.5 text-ui-xs ${statusToneClass(view.tone)}`}>
          {intl.formatMessage({ id: view.statusId })}
        </span>
        {view.background ? (
          <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "nek.status.subagent.background" })}
          </span>
        ) : null}
        <StatusActionButton
          action={actions.stop}
          actionId="stop"
          label={intl.formatMessage({ id: "nek.status.subagent.stop" })}
          ariaLabel={intl.formatMessage(
            { id: "nek.status.subagent.stopNamed" },
            { description: view.title },
          )}
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1.5 text-ui-base text-foreground"
        >
          <Square aria-hidden="true" className="size-3 fill-current" />
        </StatusActionButton>
      </div>
      <p className="mt-1 truncate text-ui-sm text-foreground-subtle">
        {view.metaParts.join(" · ")}
      </p>
      {view.activity ? (
        <p className="mt-1 truncate text-ui-sm text-foreground-subtle" title={view.activity}>
          {view.activity}
        </p>
      ) : null}
      {body ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-ui-sm text-foreground">{body}</p>
      ) : null}
      {actions.openTranscript.error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {actions.openTranscript.error}
        </p>
      ) : null}
    </section>
  );
}
