/**
 * 首次引导的纯状态机。
 *
 * 状态机只拥有步骤游标与步骤状态；安装、登录、工作区选择等副作用由调用方执行。
 */

export const ONBOARDING_STEPS = ["nek", "account", "workspace"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type OnboardingStepStatus = "pending" | "completed" | "skipped";
export type OnboardingFlowStatus = "active" | "completed" | "skipped";

export interface OnboardingFlowState {
  currentStep: OnboardingStep;
  steps: Readonly<Record<OnboardingStep, OnboardingStepStatus>>;
  status: OnboardingFlowStatus;
}

const STEP_INDEX: Readonly<Record<OnboardingStep, number>> = {
  nek: 0,
  account: 1,
  workspace: 2,
};

function statusWith(
  state: OnboardingFlowState,
  step: OnboardingStep,
  status: OnboardingStepStatus,
): OnboardingFlowState {
  return {
    ...state,
    steps: { ...state.steps, [step]: status },
  };
}

export function createOnboardingFlowState(
  currentStep: OnboardingStep = "nek",
): OnboardingFlowState {
  return {
    currentStep,
    steps: { nek: "pending", account: "pending", workspace: "pending" },
    status: "active",
  };
}

export function advanceOnboardingStep(state: OnboardingFlowState): OnboardingFlowState {
  if (state.status !== "active") {
    return state;
  }

  const marked = statusWith(state, state.currentStep, "completed");
  const index = STEP_INDEX[state.currentStep];
  const next = ONBOARDING_STEPS[index + 1];
  if (!next) {
    return { ...marked, status: "completed" };
  }
  return { ...marked, currentStep: next };
}

export function skipOnboardingStep(state: OnboardingFlowState): OnboardingFlowState {
  if (state.status !== "active") {
    return state;
  }

  const marked = statusWith(state, state.currentStep, "skipped");
  const index = STEP_INDEX[state.currentStep];
  const next = ONBOARDING_STEPS[index + 1];
  if (!next) {
    return { ...marked, status: "skipped" };
  }
  return { ...marked, currentStep: next };
}

export function backOnboardingStep(state: OnboardingFlowState): OnboardingFlowState {
  const previous = ONBOARDING_STEPS[STEP_INDEX[state.currentStep] - 1];
  return previous ? { ...state, currentStep: previous } : state;
}

/** 只允许跳回已经处理过的步骤，不能越过当前步骤向前跳。 */
export function goToOnboardingStep(
  state: OnboardingFlowState,
  step: OnboardingStep,
): OnboardingFlowState {
  const targetIndex = STEP_INDEX[step];
  const currentIndex = STEP_INDEX[state.currentStep];
  if (targetIndex > currentIndex || state.steps[step] === "pending") {
    return state;
  }
  return { ...state, currentStep: step };
}

/** 用户从引导入口直接退出时使用；显式区分于完成全部步骤。 */
export function skipOnboardingFlow(state: OnboardingFlowState): OnboardingFlowState {
  return {
    ...state,
    status: "skipped",
    steps: { nek: "skipped", account: "skipped", workspace: "skipped" },
  };
}

export function completeOnboardingFlow(state: OnboardingFlowState): OnboardingFlowState {
  return {
    ...statusWith(state, state.currentStep, "completed"),
    status: "completed",
  };
}

export function isOnboardingFlowFinished(state: OnboardingFlowState): boolean {
  return state.status !== "active";
}

export function isOnboardingStepVisited(
  state: OnboardingFlowState,
  step: OnboardingStep,
): boolean {
  return state.steps[step] !== "pending";
}
