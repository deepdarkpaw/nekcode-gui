import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useUsageIndicatorController,
  type UsageIndicatorControllerProps,
} from "./useUsageIndicatorController.js";
import { StatusActionButton, statusMessageText, usageLevelClass } from "./viewPrimitives.js";

export type NekUsageIndicatorViewProps = UsageIndicatorControllerProps;

export function NekUsageIndicatorView(props: NekUsageIndicatorViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions, onKeyDown } = useUsageIndicatorController(props);
  if (view.state !== "ready") return null;
  const contextSummary =
    view.context.percent === null
      ? intl.formatMessage({ id: view.context.hintId })
      : statusMessageText(intl, view.context.summary);
  const summary =
    view.context.percent === null
      ? contextSummary
      : `${view.context.percent}% · ${view.context.tokens}/${view.context.window}`;
  const details = [
    `${intl.formatMessage({ id: "tokenDebug.column.input" })}: ${view.tokens.input}`,
    `${intl.formatMessage({ id: "tokenDebug.column.output" })}: ${view.tokens.output}`,
    `${intl.formatMessage({ id: "tokenDebug.column.cacheRead" })}: ${view.tokens.cacheRead}`,
    `${intl.formatMessage({ id: "tokenDebug.column.cacheWrite" })}: ${view.tokens.cacheWrite}`,
    `${intl.formatMessage({ id: "tokenDebug.column.total" })}: ${view.tokens.total}`,
    `${intl.formatMessage({ id: "settings.nek.modelEditor.cost" })}: ${view.tokens.cost}`,
  ].join(" · ");
  const compactLabel = intl.formatMessage({ id: "nek.status.usage.compact" });
  return (
    <Fold
      defaultOpen={false}
      data-status-view="usage-indicator"
      className={`rounded-lg border border-card-border bg-card px-3 py-1.5 ${view.stale ? "opacity-70" : ""}`}
      onKeyDown={onKeyDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FoldTrigger
          chevron="end"
          title={details}
          className={`min-w-0 flex-1 justify-start text-ui-sm ${usageLevelClass(view.level)}`}
        >
          <span className="truncate">{summary}</span>
        </FoldTrigger>
        <StatusActionButton
          action={actions.compact}
          actionId="compact"
          label={compactLabel}
          variant="outline"
          size="xs"
        />
      </div>
      <FoldContent className="pt-2">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
          <div>
            <dt className="inline">{intl.formatMessage({ id: "tokenDebug.column.input" })}: </dt>
            <dd className="inline text-foreground">{view.tokens.input}</dd>
          </div>
          <div>
            <dt className="inline">{intl.formatMessage({ id: "tokenDebug.column.output" })}: </dt>
            <dd className="inline text-foreground">{view.tokens.output}</dd>
          </div>
          <div>
            <dt className="inline">
              {intl.formatMessage({ id: "tokenDebug.column.cacheRead" })}:{" "}
            </dt>
            <dd className="inline text-foreground">{view.tokens.cacheRead}</dd>
          </div>
          <div>
            <dt className="inline">
              {intl.formatMessage({ id: "tokenDebug.column.cacheWrite" })}:{" "}
            </dt>
            <dd className="inline text-foreground">{view.tokens.cacheWrite}</dd>
          </div>
          <div>
            <dt className="inline">{intl.formatMessage({ id: "tokenDebug.column.total" })}: </dt>
            <dd className="inline text-foreground">{view.tokens.total}</dd>
          </div>
          <div>
            <dt className="inline">
              {intl.formatMessage({ id: "settings.nek.modelEditor.cost" })}:{" "}
            </dt>
            <dd className="inline text-foreground">{view.tokens.cost}</dd>
          </div>
        </dl>
      </FoldContent>
    </Fold>
  );
}
