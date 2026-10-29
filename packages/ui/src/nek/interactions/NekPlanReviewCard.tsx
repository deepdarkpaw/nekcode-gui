import type { NekPlanReviewPayload } from "@zcode/shared/nek-protocol";
import { FileTextIcon } from "lucide-react";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlanReviewController, type PlanReviewControllerProps } from "./planReviewController.js";
import { InteractionActionButton } from "./InteractionActionButton.js";

export interface NekPlanReviewCardProps extends PlanReviewControllerProps {
  payload: NekPlanReviewPayload;
}

const ACTION_LABELS = {
  exit: "nek.interaction.plan.exit",
  later: "nek.interaction.plan.later",
  keepPlanning: "nek.interaction.plan.keepPlanning",
  implementFresh: "nek.interaction.plan.implementFresh",
  implement: "nek.interaction.plan.implement",
} as const;

/** Thin visual layer for the structured plan_review controller. */
export function NekPlanReviewCard(props: NekPlanReviewCardProps) {
  const controller = usePlanReviewController(props);
  const { intl } = useZCodeIntl();
  const { view } = controller;
  const [exit, ...rightActions] = controller.actionOrder;
  const actions = controller.actions;

  return (
    <div className="w-full shrink-0">
      <div
        ref={controller.focus.ref("card")}
        tabIndex={-1}
        data-interaction-focus="card"
        data-testid="nek-plan-review-card"
        className="relative z-1 flex max-h-[min(78dvh,48rem)] w-full flex-col overflow-hidden rounded-2xl border border-popover-border bg-popover shadow-xs outline-none"
        onKeyDown={controller.onKeyDown}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="break-words text-ui-lg font-medium text-foreground">{view.name}</h2>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "nek.interaction.plan.revision" },
                  { revision: view.revision },
                )}
              </p>
              <p className="break-all font-mono text-ui-sm text-foreground-subtle">{view.path}</p>
            </div>
            <InteractionActionButton
              handle={actions.openFile}
              labelId="nek.interaction.plan.openFile"
              size="sm"
              icon={<FileTextIcon aria-hidden="true" />}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
            <section className="space-y-2">
              <h3 className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "nek.interaction.plan.overview" })}
              </h3>
              <p className="whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
                {view.overview}
              </p>
            </section>

            {view.todos.length > 0 ? (
              <section className="mt-4 space-y-2">
                <h3 className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage(
                    { id: "nek.interaction.plan.todos" },
                    { count: view.todoCount },
                  )}
                </h3>
                <ul className="space-y-1 rounded-xl border border-card-border bg-card p-3">
                  {view.todos.map((todo) => (
                    <li key={todo.id} className="flex gap-2 text-ui-base text-foreground">
                      <span aria-hidden="true" className="text-foreground-subtle">
                        •
                      </span>
                      <span className="min-w-0 break-words">{todo.content}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section className="mt-4 overflow-hidden rounded-xl border border-card-border bg-card">
              <Fold
                open={view.expanded}
                onOpenChange={() => void actions.toggleBody.run()}
                data-testid="nek-plan-review-body"
              >
                <FoldTrigger
                  data-interaction-action="toggleBody"
                  className="w-full px-3 py-2 text-ui-base font-medium text-foreground hover:bg-hover"
                  onClick={(event) => {
                    event.preventDefault();
                    void actions.toggleBody.run();
                  }}
                >
                  {intl.formatMessage({
                    id: view.expanded ? "ui.fold.collapse" : "ui.fold.expand",
                  })}
                </FoldTrigger>
                {!view.expanded && view.bodyPreviewLines ? (
                  <pre className="max-h-40 overflow-hidden whitespace-pre-wrap break-words border-t border-card-border px-3 py-2 font-mono text-ui-sm text-foreground-subtle">
                    {view.bodyPreviewLines.join("\n")}
                  </pre>
                ) : null}
                <FoldContent>
                  <pre className="whitespace-pre-wrap break-words border-t border-card-border px-3 py-2 font-mono text-ui-sm text-foreground">
                    {view.markdown}
                  </pre>
                </FoldContent>
              </Fold>
            </section>
          </div>

          {view.notice ? (
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: view.notice })}
            </p>
          ) : null}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-popover-border px-1 pt-3 max-sm:flex-wrap">
            <InteractionActionButton
              handle={actions[exit]}
              labelId={ACTION_LABELS[exit]}
              size="lg"
            />
            <div className="flex shrink-0 items-center gap-2 max-sm:flex-wrap">
              {rightActions.map((actionId) => (
                <InteractionActionButton
                  key={actionId}
                  handle={actions[actionId]}
                  labelId={ACTION_LABELS[actionId]}
                  size="lg"
                  ref={actionId === "implement" ? controller.focus.ref("implement") : undefined}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
