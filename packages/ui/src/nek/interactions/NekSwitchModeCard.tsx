import type { NekSwitchModePayload } from "@zcode/shared/nek-protocol";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSwitchModeController, type SwitchModeControllerProps } from "./switchModeController.js";
import { InteractionActionButton } from "./InteractionActionButton.js";

export interface NekSwitchModeCardProps extends SwitchModeControllerProps {
  payload: NekSwitchModePayload;
}

/** Thin visual layer for the structured switch_mode controller. */
export function NekSwitchModeCard(props: NekSwitchModeCardProps) {
  const controller = useSwitchModeController(props);
  const { intl } = useZCodeIntl();
  const approveLabelId =
    controller.view.to === "plan"
      ? "nek.interaction.mode.approvePlan"
      : "nek.interaction.mode.approveAgent";
  const rejectLabelId =
    controller.view.from === "agent"
      ? "nek.interaction.mode.keepAgent"
      : "nek.interaction.mode.keepPlan";

  return (
    <div className="w-full shrink-0">
      <div
        ref={controller.focus.ref("card")}
        tabIndex={-1}
        data-interaction-focus="card"
        data-testid="nek-switch-mode-card"
        className="relative z-1 flex w-full flex-col overflow-hidden rounded-2xl border border-popover-border bg-popover shadow-xs outline-none"
        onKeyDown={controller.onKeyDown}
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-3">
            <h2 className="text-ui-lg font-medium text-foreground">
              {intl.formatMessage({ id: "nek.interaction.mode.title" })}
            </h2>
          </div>
          {controller.view.explanation ? (
            <p className="whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
              {controller.view.explanation}
            </p>
          ) : null}
          {controller.view.notice ? (
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: controller.view.notice })}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2 border-t border-popover-border pt-3">
            <InteractionActionButton
              handle={controller.actions.reject}
              labelId={rejectLabelId}
              size="lg"
              ref={controller.focus.ref("reject")}
            />
            <InteractionActionButton
              handle={controller.actions.approve}
              labelId={approveLabelId}
              size="lg"
              ref={controller.focus.ref("approve")}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
