import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  openOnboarding as resolveOnboardingStart,
  useNekOnboardingGate,
} from "./useNekOnboardingGate.js";
import {
  useNekOnboardingController,
  type OnboardingController,
  type OnboardingControllerProps,
} from "./useNekOnboardingController.js";
import { ONBOARDING_STEPS } from "./onboardingFlow.js";
import {
  OnboardingActionButton,
  OnboardingStepBody,
  ONBOARDING_STEP_LABELS,
  formatOnboardingMessage,
} from "./NekOnboardingSteps.js";

export const NEK_ONBOARDING_OPEN_EVENT = "nekcode:open-nek-onboarding";
export const NEK_ONBOARDING_REMOTE_SELECTED_EVENT = "nekcode:nek-onboarding-remote-selected";

export function requestNekOnboardingOpen(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NEK_ONBOARDING_OPEN_EVENT));
}

export interface NekOnboardingModalProps extends Omit<
  OnboardingControllerProps,
  "open" | "childDialogOpen"
> {
  open?: boolean;
  childDialogOpen?: boolean;
}

export function NekOnboardingModal(props: NekOnboardingModalProps) {
  const { intl } = useZCodeIntl();
  const gate = useNekOnboardingGate();
  const [requestedOpen, setRequestedOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [startStep, setStartStep] = useState(props.startStep ?? "nek");
  const controllerRef = useRef<OnboardingController | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const controlled = props.open !== undefined;
  const isOpen = controlled
    ? props.open === true
    : !dismissed && (requestedOpen || gate.status === "show");
  const controller = useNekOnboardingController({
    open: isOpen,
    startStep,
    childDialogOpen: props.childDialogOpen ?? false,
    activeElementInfo: props.activeElementInfo,
    now: props.now,
    onComplete: async (selection) => {
      await props.onComplete(selection);
      if (!controlled) {
        setRequestedOpen(false);
        setDismissed(true);
      }
    },
    onClose: () => {
      if (!controlled) {
        setRequestedOpen(false);
        setDismissed(true);
      }
      props.onClose();
    },
    onOpenLogin: props.onOpenLogin,
    onOpenProviderForm: props.onOpenProviderForm,
    onOpenRemote: props.onOpenRemote,
  });
  controllerRef.current = controller;

  useEffect(() => {
    const handleOpen = () => {
      const current = controllerRef.current;
      if (current) {
        setStartStep(
          resolveOnboardingStart({
            checking: current.view.nek.status === "checking",
            done: {
              nek: current.view.steps.nek === "done",
              account: current.view.steps.account === "done",
              workspace: current.view.steps.workspace === "done",
            },
          }).step,
        );
      }
      setDismissed(false);
      setRequestedOpen(true);
    };
    window.addEventListener(NEK_ONBOARDING_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(NEK_ONBOARDING_OPEN_EVENT, handleOpen);
  }, []);

  useEffect(() => {
    const handleRemoteSelected = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId: string; path: string; label: string }>)
        .detail;
      if (detail) controllerRef.current?.setRemoteSelected(detail);
    };
    window.addEventListener(NEK_ONBOARDING_REMOTE_SELECTED_EVENT, handleRemoteSelected);
    return () =>
      window.removeEventListener(NEK_ONBOARDING_REMOTE_SELECTED_EVENT, handleRemoteSelected);
  }, []);

  if (!isOpen) return null;
  const navigation = controller.actions;
  const step = controller.view.currentStep;
  const nextLabel = formatOnboardingMessage(
    intl,
    step === "workspace" ? "onboarding.finish" : "onboarding.next",
  );
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) void navigation.close.run();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
            {formatOnboardingMessage(intl, "onboarding.dialog.title")}
          </DialogTitle>
          <DialogDescription>
            {formatOnboardingMessage(intl, "onboarding.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div onKeyDown={controller.onKeyDown} className="flex flex-col gap-4">
          <nav
            aria-label={formatOnboardingMessage(intl, "onboarding.steps.label")}
            className="flex flex-wrap items-center gap-2"
          >
            {ONBOARDING_STEPS.map((item, index) => {
              const action = navigation.jumpTo(item);
              const active = item === step;
              const label = formatOnboardingMessage(intl, ONBOARDING_STEP_LABELS[item]);
              const content = (
                <>
                  {controller.view.steps[item] === "done" ? (
                    <CheckIcon className="size-4" aria-hidden="true" />
                  ) : (
                    <span className="text-ui-sm tabular-nums" aria-hidden="true">
                      {index + 1}
                    </span>
                  )}
                  {label}
                </>
              );
              return (
                <span key={item} aria-current={active ? "step" : undefined}>
                  {action.visible ? (
                    <OnboardingActionButton
                      action={action}
                      label={label}
                      intl={intl}
                      variant={active ? "outline" : "ghost"}
                    >
                      {content}
                    </OnboardingActionButton>
                  ) : (
                    <span className="inline-flex items-center gap-2 px-3 py-2 text-ui-base text-foreground-subtlest">
                      {content}
                    </span>
                  )}
                </span>
              );
            })}
          </nav>
          {controller.view.attention ? (
            <p role="status" className="text-ui-sm text-warning">
              {formatOnboardingMessage(intl, "ui.action.busy")}
            </p>
          ) : null}
          <OnboardingStepBody controller={controller} />
        </div>
        <DialogFooter className="flex-wrap items-center sm:justify-between">
          <OnboardingActionButton
            action={navigation.close}
            label={formatOnboardingMessage(intl, "onboarding.close")}
            intl={intl}
            variant="ghost"
          />
          <div className="flex flex-wrap gap-2">
            <OnboardingActionButton
              action={navigation.back}
              label={formatOnboardingMessage(intl, "onboarding.back")}
              intl={intl}
              variant="outline"
            >
              <ChevronLeftIcon aria-hidden="true" />
              {formatOnboardingMessage(intl, "onboarding.back")}
            </OnboardingActionButton>
            <OnboardingActionButton
              action={navigation.skip}
              label={formatOnboardingMessage(intl, "onboarding.skip")}
              intl={intl}
              variant="ghost"
            />
            <OnboardingActionButton
              action={navigation.next}
              label={nextLabel}
              intl={intl}
              ref={controller.focus.ref("next")}
            >
              {nextLabel}
              <ChevronRightIcon aria-hidden="true" />
            </OnboardingActionButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
