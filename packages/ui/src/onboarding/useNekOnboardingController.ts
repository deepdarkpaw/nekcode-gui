import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNekHostApi } from "@/settings/nek/api/NekSettingsContext.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import { useOnboardingAction, type OnboardingActionHandle } from "./onboardingAction.js";
import {
  createOnboardingFlowState,
  reduceOnboardingFlow,
  type OnboardingFlowState,
  type OnboardingSelection,
  type OnboardingStep,
} from "./onboardingFlow.js";
import { shouldTakeFocus, type ActiveElementInfo } from "./onboardingFocus.js";
import { resolveOnboardingKey } from "./onboardingKeyboard.js";
import { useNekStepController } from "./onboardingNek.js";
import { useOnboardingAccountController } from "./onboardingAccountController.js";
import { useOnboardingWorkspaceController } from "./onboardingWorkspaceController.js";

export type OnboardingPrimaryActionId =
  | "install"
  | "update"
  | "recheck"
  | "loginAnthropic"
  | "pickLocal"
  | "next";

export interface OnboardingControllerProps {
  open: boolean;
  startStep?: OnboardingStep;
  childDialogOpen: boolean;
  activeElementInfo?: ActiveElementInfo | null;
  now?: () => string;
  onComplete: (selection: OnboardingSelection | null) => Promise<void> | void;
  onClose: () => void;
  onOpenLogin: (provider: "anthropic" | "openai-codex") => void;
  onOpenProviderForm: () => void;
  onOpenRemote: () => void;
}

export interface OnboardingController {
  view: {
    open: boolean;
    currentStep: OnboardingStep;
    furthest: OnboardingStep;
    steps: OnboardingFlowState["steps"];
    primaryActionId: OnboardingPrimaryActionId;
    attention: boolean;
    nek: ReturnType<typeof useNekStepController>["state"];
    account: ReturnType<typeof useOnboardingAccountController>["view"];
    workspace: ReturnType<typeof useOnboardingWorkspaceController>["view"];
  };
  actions: {
    back: OnboardingActionHandle;
    skip: OnboardingActionHandle;
    next: OnboardingActionHandle;
    close: OnboardingActionHandle;
    install: OnboardingActionHandle;
    update: OnboardingActionHandle;
    cancelInstall: OnboardingActionHandle;
    recheck: OnboardingActionHandle;
    copyCommand: OnboardingActionHandle;
    loginAnthropic: OnboardingActionHandle;
    loginCodex: OnboardingActionHandle;
    addProvider: OnboardingActionHandle;
    refreshAccount: OnboardingActionHandle;
    pickLocal: OnboardingActionHandle;
    openRemote: OnboardingActionHandle;
    clearSelection: OnboardingActionHandle;
  };
  onKeyDown: (event: ReactKeyboardEvent) => void;
  focus: {
    target: OnboardingPrimaryActionId | null;
    ref: (id: OnboardingPrimaryActionId) => (element: HTMLElement | null) => void;
  };
  setRemoteSelected: (selection: { connectionId: string; path: string; label: string }) => void;
}

const INSTALLING_REASON = { id: "onboarding.nek.installing" };
const NEED_NEK_REASON = { id: "onboarding.nek.needNek" };
const NEED_ACCOUNT_REASON = { id: "onboarding.account.needAccount" };
const NEED_WORKSPACE_REASON = { id: "onboarding.workspace.needWorkspace" };

function useFlowReducer(startStep: OnboardingStep, open: boolean) {
  const [state, dispatch] = useReducer(reduceOnboardingFlow, startStep, createOnboardingFlowState);
  const previousOpen = useRef(open);
  useEffect(() => {
    if (open && !previousOpen.current) dispatch({ type: "reset", startStep });
    previousOpen.current = open;
  }, [open, startStep]);
  return [state, dispatch] as const;
}

function actionEnabled(enabled: boolean, installing: boolean, reason: { id: string }) {
  return enabled && !installing ? undefined : installing ? INSTALLING_REASON : reason;
}

export function useNekOnboardingController(
  props: OnboardingControllerProps,
): OnboardingController {
  const api = useNekHostApi();
  const [flow, dispatch] = useFlowReducer(props.startStep ?? "nek", props.open);
  const nekController = useNekStepController({ active: props.open && flow.currentStep === "nek" });
  const accountController = useOnboardingAccountController({
    active: props.open && flow.currentStep === "account",
    onOpenLogin: props.onOpenLogin,
    onOpenProviderForm: props.onOpenProviderForm,
  });
  const workspaceController = useOnboardingWorkspaceController({ onOpenRemote: props.onOpenRemote });
  const [attention, setAttention] = useState(false);
  const now = props.now ?? (() => new Date().toISOString());

  useEffect(() => {
    dispatch({ type: "setStepDone", step: "nek", done: nekController.state.status === "ready" });
  }, [nekController.state.status]);
  useEffect(() => {
    dispatch({ type: "setStepDone", step: "account", done: accountController.view.done });
  }, [accountController.view.done]);
  useEffect(() => {
    dispatch({ type: "setSelection", selection: workspaceController.view.selection });
  }, [workspaceController.view.selection]);
  useEffect(() => {
    dispatch({ type: "setInstalling", installing: nekController.state.status === "installing" });
  }, [nekController.state.status]);

  const finish = useCallback(
    async (selection: OnboardingSelection | null) => {
      await api.setOnboardingState({ completedAt: now() });
      await props.onComplete(selection);
      dispatch({ type: "next" });
    },
    [api, now, props.onComplete],
  );
  const close = useCallback(async () => {
    await api.setOnboardingState({ dismissedAt: now() });
    props.onClose();
  }, [api, now, props.onClose]);

  const back = useOnboardingAction({
    action: async () => dispatch({ type: "back" }),
    visible: flow.currentStep !== "nek",
    enabled: flow.currentStep !== "nek" && !flow.installing,
    disabledReason: actionEnabled(flow.currentStep !== "nek", flow.installing, INSTALLING_REASON),
  });
  const skip = useOnboardingAction({
    action: async () => {
      if (flow.currentStep === "workspace") await finish(null);
      else dispatch({ type: "skip" });
    },
    visible: flow.steps[flow.currentStep] !== "done",
    enabled: !flow.installing,
    disabledReason: actionEnabled(true, flow.installing, INSTALLING_REASON),
  });
  const next = useOnboardingAction({
    action: async () => {
      if (flow.currentStep === "workspace") await finish(workspaceController.view.selection);
      else dispatch({ type: "next" });
    },
    enabled: flow.steps[flow.currentStep] === "done" && !flow.installing,
    primary: flow.steps[flow.currentStep] === "done",
    disabledReason: actionEnabled(
      flow.steps[flow.currentStep] === "done",
      flow.installing,
      flow.currentStep === "nek"
        ? NEED_NEK_REASON
        : flow.currentStep === "account"
          ? NEED_ACCOUNT_REASON
          : NEED_WORKSPACE_REASON,
    ),
  });
  const closeAction = useOnboardingAction({
    action: close,
    enabled: !flow.installing,
    destructive: false,
    disabledReason: actionEnabled(true, flow.installing, INSTALLING_REASON),
  });
  const install = useOnboardingAction({
    action: nekController.install,
    visible: ["not_installed", "install_failed", "install_cancelled"].includes(nekController.state.status),
    primary: flow.currentStep === "nek" && flow.steps.nek !== "done",
  });
  const update = useOnboardingAction({
    action: nekController.install,
    visible: nekController.state.status === "incompatible",
    primary: flow.currentStep === "nek" && flow.steps.nek !== "done",
  });
  const cancelInstall = useOnboardingAction({
    action: nekController.cancelInstall,
    visible: nekController.state.status === "installing",
  });
  const recheck = useOnboardingAction({
    action: nekController.detect,
    visible: ["not_installed", "incompatible", "failed", "install_failed", "install_cancelled"].includes(nekController.state.status),
    enabled: nekController.state.status !== "checking" && nekController.state.status !== "installing",
    disabledReason:
      nekController.state.status === "checking"
        ? { id: "onboarding.nek.checking" }
        : INSTALLING_REASON,
  });
  const copyCommand = useOnboardingAction({
    action: async () => {
      if (!nekController.state.manualCommand) return;
      await api.copyText(nekController.state.manualCommand);
    },
    visible: nekController.state.status === "install_failed" && Boolean(nekController.state.manualCommand),
  });

  const actions = {
    back,
    skip,
    next,
    close: closeAction,
    install,
    update,
    cancelInstall,
    recheck,
    copyCommand,
    loginAnthropic: accountController.actions.loginAnthropic,
    loginCodex: accountController.actions.loginCodex,
    addProvider: accountController.actions.addProvider,
    refreshAccount: accountController.actions.refresh,
    pickLocal: workspaceController.actions.pickLocal,
    openRemote: workspaceController.actions.openRemote,
    clearSelection: workspaceController.actions.clearSelection,
  };

  const primaryActionId: OnboardingPrimaryActionId =
    flow.steps[flow.currentStep] === "done"
      ? "next"
      : flow.currentStep === "nek"
        ? nekController.state.status === "incompatible"
          ? "update"
          : "install"
        : flow.currentStep === "account"
          ? "loginAnthropic"
          : "pickLocal";

  const focusElements = useRef(new Map<OnboardingPrimaryActionId, HTMLElement>());
  const focusRef = useCallback(
    (id: OnboardingPrimaryActionId) => (element: HTMLElement | null) => {
      if (element) focusElements.current.set(id, element);
      else focusElements.current.delete(id);
    },
    [],
  );
  useEffect(() => {
    if (!props.open) return;
    if (!shouldTakeFocus(props.activeElementInfo ?? null)) {
      setAttention(true);
      return;
    }
    setAttention(false);
    const frame = globalThis.requestAnimationFrame?.(() => focusElements.current.get(primaryActionId)?.focus());
    return () => {
      if (frame !== undefined) globalThis.cancelAnimationFrame?.(frame);
    };
  }, [primaryActionId, props.activeElementInfo, props.open, flow.currentStep]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (isImeComposing(event)) return;
      const command = resolveOnboardingKey({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        childDialogOpen: props.childDialogOpen,
        canBack: back.enabled,
        canNext: next.enabled,
        installing: flow.installing,
      });
      if (!command) return;
      event.preventDefault();
      if (command === "close") event.stopPropagation();
      void actions[command].run();
    },
    [actions, back.enabled, flow.installing, next.enabled, props.childDialogOpen],
  );

  return {
    view: {
      open: props.open,
      currentStep: flow.currentStep,
      furthest: flow.furthest,
      steps: flow.steps,
      primaryActionId,
      attention,
      nek: nekController.state,
      account: accountController.view,
      workspace: workspaceController.view,
    },
    actions,
    onKeyDown,
    focus: { target: props.open ? primaryActionId : null, ref: focusRef },
    setRemoteSelected: workspaceController.setRemoteSelected,
  };
}
