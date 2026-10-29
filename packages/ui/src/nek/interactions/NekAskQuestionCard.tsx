import { CheckIcon, InfoIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useAskQuestionController,
  type AskQuestionControllerProps,
} from "./askQuestionController.js";
import { InteractionActionButton } from "./InteractionActionButton.js";

export interface NekAskQuestionCardProps extends Omit<
  AskQuestionControllerProps,
  "queueLength" | "isQueueHead"
> {
  queueLength?: number;
  isQueueHead?: boolean;
}

function Notice({ id }: { id: string }) {
  const { intl } = useZCodeIntl();
  return (
    <p role="status" className="text-ui-sm text-foreground-subtle">
      {intl.formatMessage({ id })}
    </p>
  );
}

/** Thin visual layer for the structured ask_question controller. */
export function NekAskQuestionCard({
  payload,
  queueLength,
  activeElement,
  isQueueHead,
  closedByHost,
  onSubmit,
  onDismiss,
}: NekAskQuestionCardProps) {
  const controller = useAskQuestionController({
    payload,
    queueLength,
    activeElement,
    isQueueHead,
    closedByHost,
    onSubmit,
    onDismiss,
  });
  const { intl } = useZCodeIntl();
  const questionIndex = controller.view.progress ? controller.view.progress.current - 1 : 0;
  const question = payload.questions[questionIndex];
  if (!question) return null;

  const draft = controller.view.drafts[question.id] ?? { selected: [], other: "" };
  const optionRole = question.allow_multiple ? "checkbox" : "option";
  const progress = controller.view.progress;

  return (
    <div className="w-full shrink-0">
      <div
        ref={controller.focus.ref("card")}
        tabIndex={controller.view.active < 0 ? 0 : -1}
        data-interaction-focus="card"
        data-testid="nek-ask-question-card"
        className="relative z-1 flex max-h-[min(72dvh,42rem)] w-full flex-col overflow-hidden rounded-2xl border border-popover-border bg-popover shadow-xs outline-none"
        onKeyDown={controller.onKeyDown}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {controller.view.title ? (
                <h2 className="text-ui-base font-medium text-foreground">
                  {controller.view.title}
                </h2>
              ) : null}
              <p className="whitespace-pre-wrap break-words text-ui-base leading-6 text-foreground">
                {controller.view.prompt}
              </p>
            </div>
            {progress ? (
              <div className="flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle">
                <InteractionActionButton
                  handle={controller.actions.previous}
                  labelId="nek.interaction.question.previous"
                  size="icon-xs"
                  aria-label={intl.formatMessage({ id: "nek.interaction.question.previous" })}
                />
                <span className="min-w-14 text-center">
                  {intl.formatMessage(
                    { id: "nek.interaction.question.progress" },
                    { current: progress.current, total: progress.total },
                  )}
                </span>
                <InteractionActionButton
                  handle={controller.actions.next}
                  labelId="nek.interaction.question.next"
                  size="icon-xs"
                  aria-label={intl.formatMessage({ id: "nek.interaction.question.next" })}
                />
              </div>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
            <div
              role={question.allow_multiple ? "group" : "listbox"}
              aria-label={controller.view.prompt}
              className="space-y-1"
            >
              {question.options.map((option, index) => {
                const selected = draft.selected.includes(option.id);
                const active = controller.view.active === index;
                return (
                  <button
                    key={option.id}
                    ref={controller.focus.ref(`option:${index}`)}
                    type="button"
                    role={optionRole}
                    aria-selected={question.allow_multiple ? undefined : selected}
                    aria-checked={question.allow_multiple ? selected : undefined}
                    tabIndex={controller.getOptionTabIndex(index)}
                    data-interaction-focus="option"
                    disabled={controller.view.locked}
                    onClick={() => controller.selectOption(index)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-ui-base outline-none transition-colors focus-visible:bg-hover",
                      selected ? "bg-selected" : active ? "bg-hover" : "hover:bg-hover",
                    )}
                  >
                    {question.allow_multiple ? (
                      <span
                        className={cn(
                          "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border text-transparent",
                        )}
                      >
                        <CheckIcon className="size-3" aria-hidden="true" />
                      </span>
                    ) : (
                      <span
                        className={cn(
                          "w-5 shrink-0 text-ui-base font-medium",
                          selected ? "text-foreground" : "text-foreground-subtlest",
                        )}
                      >
                        {index + 1}.
                      </span>
                    )}
                    <span className="min-w-0 flex-1 break-words text-ui-base text-foreground">
                      {option.label}
                    </span>
                  </button>
                );
              })}
              <div
                role={question.allow_multiple ? "checkbox" : undefined}
                aria-checked={question.allow_multiple ? Boolean(draft.other.trim()) : undefined}
                onClick={controller.focusOther}
                className={cn(
                  "flex w-full cursor-text items-start gap-3 rounded-xl px-3 py-2 transition-colors",
                  draft.other.trim()
                    ? "bg-selected"
                    : controller.view.active === question.options.length
                      ? "bg-hover"
                      : "hover:bg-hover",
                )}
              >
                <span className="mt-px w-5 shrink-0 text-ui-base font-medium text-foreground-subtlest">
                  {question.options.length + 1}.
                </span>
                <Textarea
                  ref={controller.focus.ref("other")}
                  rows={1}
                  wrap="soft"
                  value={draft.other}
                  disabled={controller.view.locked}
                  placeholder={intl.formatMessage({ id: "nek.interaction.question.other" })}
                  data-interaction-focus="other"
                  onFocus={controller.focusOther}
                  onChange={(event) => controller.setOther(event.target.value)}
                  className="h-auto !min-h-5 max-h-[5lh] min-w-0 max-w-full overflow-y-auto rounded-none border-transparent bg-transparent !px-0 !py-0 text-ui-base leading-normal shadow-none hover:border-transparent focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0"
                />
              </div>
            </div>
          </div>

          {controller.view.notice ? <Notice id={controller.view.notice} /> : null}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-popover-border px-1 pt-3 max-sm:flex-wrap">
            <p className="flex min-w-0 flex-1 items-center gap-2 text-ui-sm text-foreground-subtle">
              <InfoIcon className="size-4 shrink-0 text-foreground" aria-hidden="true" />
              <span>{intl.formatMessage({ id: controller.view.dismissHintId })}</span>
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <InteractionActionButton
                handle={controller.actions.dismiss}
                labelId="nek.interaction.question.dismiss"
                size="lg"
              />
              <InteractionActionButton
                handle={controller.actions.primary}
                labelId={controller.view.primaryLabelId}
                size="lg"
              />
            </div>
          </div>
        </div>
      </div>
      {controller.view.queueLength > 0 ? (
        <span className="sr-only">
          {intl.formatMessage(
            { id: "nek.interaction.queue.waiting" },
            { count: controller.view.queueLength },
          )}
        </span>
      ) : null}
    </div>
  );
}
