import { Check, Circle, ExternalLink, LoaderCircle, X } from "lucide-react";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTodoPanelController, type TodoPanelControllerProps } from "./useTodoPanelController.js";
import { StatusActionButton, statusMessageText } from "./viewPrimitives.js";

export type NekTodoPanelViewProps = TodoPanelControllerProps;

function todoStatusIcon(status: "pending" | "in_progress" | "completed" | "cancelled") {
  switch (status) {
    case "pending":
      return <Circle aria-hidden="true" className="text-foreground-subtle" />;
    case "in_progress":
      return <LoaderCircle aria-hidden="true" className="animate-spin text-warning" />;
    case "completed":
      return <Check aria-hidden="true" className="text-success" />;
    case "cancelled":
      return <X aria-hidden="true" className="text-foreground-subtlest" />;
  }
}

export function NekTodoPanelView(props: NekTodoPanelViewProps) {
  const { intl } = useZCodeIntl();
  const { view, actions, jump, onKeyDown } = useTodoPanelController(props);
  if (!view.visible) return null;
  const summary = statusMessageText(intl, view.summary);
  const openPlanLabel = intl.formatMessage({ id: "nek.status.todo.openPlan" });
  return (
    <Fold
      open={view.fold.open}
      onOpenChange={view.fold.onOpenChange}
      className="rounded-lg border border-card-border bg-card px-3 py-2"
      data-status-view="todo-panel"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2">
        <FoldTrigger chevron="end" className="min-w-0 flex-1">
          <span className="font-medium text-ui-base text-foreground">{summary}</span>
          {view.allDone ? <span className="text-ui-sm text-success">✓</span> : null}
        </FoldTrigger>
        <StatusActionButton
          action={actions.openPlan}
          actionId="openPlan"
          label={openPlanLabel}
          variant="outline"
          size="xs"
        >
          <ExternalLink aria-hidden="true" />
        </StatusActionButton>
      </div>
      <FoldContent className="pt-2">
        <ul className="space-y-1">
          {view.items.map((item) => {
            const changed = view.recentlyChanged.includes(item.id);
            const content = (
              <>
                {todoStatusIcon(item.status)}
                <span className="min-w-0 flex-1 truncate text-left text-ui-sm text-foreground">
                  {item.content}
                </span>
                <span className="shrink-0 text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: item.statusId })}
                </span>
              </>
            );
            return (
              <li
                key={item.id}
                className={`flex min-w-0 items-center gap-2 rounded-md px-1 py-1 ${changed ? "transition-colors bg-selected/40" : ""}`}
              >
                {item.jumpable ? (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30"
                    onClick={() => jump(item.id)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </FoldContent>
    </Fold>
  );
}
