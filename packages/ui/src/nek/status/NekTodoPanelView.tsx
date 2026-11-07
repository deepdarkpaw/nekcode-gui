import { ArrowRightIcon, CheckCircle2Icon, CircleIcon, ExternalLink, XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTodoPanelController, type TodoPanelControllerProps } from "./useTodoPanelController.js";
import { StatusActionButton, statusMessageText } from "./viewPrimitives.js";

export type NekTodoPanelViewProps = TodoPanelControllerProps;

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/**
 * 14px 状态图标：与 ZCodium `PlanStatusIcon` / todo 工具卡保持同一尺寸与配色。
 * 不带 `size-*` 时 Lucide 会退回 24px 默认尺寸，比行内文字大一圈。
 */
function todoStatusIcon(status: TodoStatus) {
  const className = "mt-0.5 size-3.5 shrink-0";
  switch (status) {
    case "pending":
      return (
        <CircleIcon aria-hidden="true" className={cn(className, "text-foreground-subtlest")} />
      );
    case "in_progress":
      return <ArrowRightIcon aria-hidden="true" className={cn(className, "text-foreground")} />;
    case "completed":
      return <CheckCircle2Icon aria-hidden="true" className={cn(className, "text-success")} />;
    case "cancelled":
      return <XIcon aria-hidden="true" className={cn(className, "text-foreground-subtlest")} />;
  }
}

function todoTextClass(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "text-foreground-subtlest line-through";
    case "cancelled":
      return "text-foreground-subtlest";
    default:
      return "text-foreground";
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
          {view.allDone ? (
            <CheckCircle2Icon aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          ) : null}
        </FoldTrigger>
        <StatusActionButton
          action={actions.openPlan}
          actionId="openPlan"
          label={openPlanLabel}
          variant="ghost"
          size="sm"
        >
          <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
        </StatusActionButton>
      </div>
      <FoldContent className="pt-2">
        <ul className="space-y-0.5">
          {view.items.map((item) => {
            const changed = view.recentlyChanged.includes(item.id);
            const content = (
              <>
                {todoStatusIcon(item.status)}
                <span
                  title={item.content}
                  className={cn(
                    "line-clamp-2 min-w-0 flex-1 break-words text-left text-ui-base leading-5",
                    todoTextClass(item.status),
                  )}
                >
                  {item.content}
                </span>
                <span className="shrink-0 text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: item.statusId })}
                </span>
              </>
            );
            const rowClass = cn(
              "flex min-h-8 min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-ui-base transition-colors",
              item.jumpable ? "hover:bg-hover" : null,
              changed ? "bg-selected/40" : null,
            );
            return (
              <li key={item.id} data-todo-status={item.status} className={rowClass}>
                {item.jumpable ? (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30"
                    onClick={() => jump(item.id)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-start gap-2">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </FoldContent>
    </Fold>
  );
}
