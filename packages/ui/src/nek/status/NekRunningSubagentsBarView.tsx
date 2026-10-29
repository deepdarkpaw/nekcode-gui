import { Square } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useRunningSubagentsBarController,
  type RunningSubagentsBarControllerProps,
} from "./useRunningSubagentsBarController.js";
import { StatusActionButton } from "./viewPrimitives.js";

export type NekRunningSubagentsBarViewProps = RunningSubagentsBarControllerProps;

export function NekRunningSubagentsBarView(props: NekRunningSubagentsBarViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions, onKeyDown } = useRunningSubagentsBarController(props);
  if (!view.visible) return null;
  const stopLabel = intl.formatMessage({ id: "nek.status.subagent.stop" });
  const stopAllLabel = intl.formatMessage({ id: "nek.status.subagent.stopAll" });
  return (
    <div
      data-status-view="running-subagents-bar"
      className="flex min-w-0 items-center gap-2 rounded-lg border border-card-border bg-surface px-2 py-1"
      onKeyDown={onKeyDown}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {view.items.map((item) => (
          <div key={item.id} className="flex min-w-0 items-center gap-0.5 rounded-md bg-card">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-w-0 max-w-52 justify-start"
              onClick={() => item.focus()}
              title={item.description}
            >
              <span className="truncate text-ui-sm text-foreground">{item.description}</span>
              <span className="shrink-0 text-ui-xs text-foreground-subtle">{item.elapsed}</span>
            </Button>
            <StatusActionButton
              action={item.stop}
              actionId={`stop:${item.id}`}
              label={stopLabel}
              ariaLabel={`${stopLabel} ${item.description}`}
              variant="destructive"
              size="xs"
            >
              <Square aria-hidden="true" />
            </StatusActionButton>
          </div>
        ))}
        <StatusActionButton
          action={actions.toggleExpand}
          actionId="toggleExpand"
          label={`+${view.overflow}`}
          variant="outline"
          size="xs"
        />
      </div>
      <StatusActionButton
        action={actions.stopAll}
        actionId="stopAll"
        label={stopAllLabel}
        variant="destructive"
        size="xs"
      />
    </div>
  );
}
