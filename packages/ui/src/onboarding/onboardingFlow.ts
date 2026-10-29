/** 首次引导 FL：纯 reducer，不发请求、不读时钟、不碰 DOM。 */

export const ONBOARDING_STEPS = ["nek", "account", "workspace"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepStatus = "pending" | "done" | "skipped";
export type OnboardingSelection =
  | { kind: "local"; path: string }
  | { kind: "remote"; connectionId: string; path: string; label: string };

export interface OnboardingFlowState {
  currentStep: OnboardingStep;
  furthest: OnboardingStep;
  steps: Readonly<Record<OnboardingStep, OnboardingStepStatus>>;
  installing: boolean;
  selection: OnboardingSelection | null;
  closed: boolean;
  completed: boolean;
}

export type OnboardingFlowEvent =
  | { type: "reset"; startStep?: OnboardingStep }
  | { type: "setStepDone"; step: OnboardingStep; done: boolean }
  | { type: "setInstalling"; installing: boolean }
  | { type: "setSelection"; selection: OnboardingSelection | null }
  | { type: "back" }
  | { type: "skip" }
  | { type: "next" }
  | { type: "jumpTo"; step: OnboardingStep }
  | { type: "close" };

const STEP_INDEX: Readonly<Record<OnboardingStep, number>> = {
  nek: 0,
  account: 1,
  workspace: 2,
};

function nextStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[STEP_INDEX[step] + 1] ?? null;
}

function previousStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[STEP_INDEX[step] - 1] ?? null;
}

function isBeforeOrAt(a: OnboardingStep, b: OnboardingStep): boolean {
  return STEP_INDEX[a] <= STEP_INDEX[b];
}

function withStep(
  state: OnboardingFlowState,
  step: OnboardingStep,
  status: OnboardingStepStatus,
): OnboardingFlowState {
  return { ...state, steps: { ...state.steps, [step]: status } };
}

function moveForward(state: OnboardingFlowState): OnboardingFlowState {
  const next = nextStep(state.currentStep);
  if (!next) return { ...state, completed: true };
  return {
    ...state,
    currentStep: next,
    furthest: isBeforeOrAt(state.furthest, next) ? next : state.furthest,
  };
}

export function createOnboardingFlowState(startStep: OnboardingStep = "nek"): OnboardingFlowState {
  return {
    currentStep: startStep,
    furthest: startStep,
    steps: { nek: "pending", account: "pending", workspace: "pending" },
    installing: false,
    selection: null,
    closed: false,
    completed: false,
  };
}

export function reduceOnboardingFlow(
  state: OnboardingFlowState,
  event: OnboardingFlowEvent,
): OnboardingFlowState {
  if (state.closed || state.completed) {
    return event.type === "reset" ? createOnboardingFlowState(event.startStep) : state;
  }
  if (state.installing && ["back", "skip", "next", "jumpTo", "close"].includes(event.type)) {
    return state;
  }
  switch (event.type) {
    case "reset":
      return createOnboardingFlowState(event.startStep);
    case "setInstalling":
      return event.installing === state.installing
        ? state
        : { ...state, installing: event.installing };
    case "setStepDone": {
      const current = state.steps[event.step];
      const nextStatus = event.done ? "done" : current === "skipped" ? "skipped" : "pending";
      return current === nextStatus ? state : withStep(state, event.step, nextStatus);
    }
    case "setSelection": {
      const done = event.selection !== null;
      const next = withStep(state, "workspace", done ? "done" : "pending");
      return next.selection === event.selection ? state : { ...next, selection: event.selection };
    }
    case "back": {
      const previous = previousStep(state.currentStep);
      return previous ? { ...state, currentStep: previous } : state;
    }
    case "jumpTo":
      return STEP_INDEX[event.step] <= STEP_INDEX[state.furthest]
        ? { ...state, currentStep: event.step }
        : state;
    case "skip":
      if (state.steps[state.currentStep] === "done") return state;
      if (state.currentStep === "workspace") return { ...state, completed: true };
      return moveForward(withStep(state, state.currentStep, "skipped"));
    case "next":
      if (state.steps[state.currentStep] !== "done") return state;
      return moveForward(state);
    case "close":
      return { ...state, closed: true };
  }
}

export function firstIncompleteStep(
  done: Readonly<Record<OnboardingStep, boolean>>,
): OnboardingStep {
  if (!done.nek) return "nek";
  if (!done.account) return "account";
  return "workspace";
}

export function isOnboardingStepDone(state: OnboardingFlowState, step: OnboardingStep): boolean {
  return state.steps[step] === "done";
}
