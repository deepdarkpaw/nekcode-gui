import { describe, expect, it } from "vitest";
import {
  createOnboardingFlowState,
  reduceOnboardingFlow,
  type OnboardingFlowEvent,
} from "./onboardingFlow.js";

function transition(
  state: ReturnType<typeof createOnboardingFlowState>,
  event: OnboardingFlowEvent,
) {
  return reduceOnboardingFlow(state, event);
}

describe("onboarding flow reducer", () => {
  it("FL-1: derives done from detection events instead of clicks", () => {
    const initial = createOnboardingFlowState();
    const ready = transition(initial, { type: "setStepDone", step: "nek", done: true });
    expect(ready.steps.nek).toBe("done");
    expect(ready.currentStep).toBe("nek");
    expect(ready).not.toBe(initial);
  });

  it("FL-2: reset keeps an explicit start step and never auto-advances", () => {
    const state = createOnboardingFlowState("nek");
    const ready = transition(state, { type: "setStepDone", step: "nek", done: true });
    expect(ready.currentStep).toBe("nek");
    expect(transition(ready, { type: "reset", startStep: "account" }).currentStep).toBe("account");
  });

  it("FL-3: next records furthest and jumpTo allows only visited steps", () => {
    let state = createOnboardingFlowState();
    state = transition(state, { type: "setStepDone", step: "nek", done: true });
    state = transition(state, { type: "next" });
    expect(state.furthest).toBe("account");
    expect(transition(state, { type: "jumpTo", step: "nek" }).currentStep).toBe("nek");
    const initial = createOnboardingFlowState();
    expect(transition(initial, { type: "jumpTo", step: "account" })).toBe(initial);
  });

  it("FL-4: every navigation event is an identity no-op while installing", () => {
    let state = createOnboardingFlowState();
    state = transition(state, { type: "setInstalling", installing: true });
    for (const event of [
      { type: "back" },
      { type: "skip" },
      { type: "next" },
      { type: "jumpTo", step: "nek" as const },
      { type: "close" },
    ] satisfies OnboardingFlowEvent[]) {
      expect(transition(state, event)).toBe(state);
    }
  });

  it("FL-5: workspace next and skip both complete the flow", () => {
    let state = createOnboardingFlowState("workspace");
    state = transition(state, {
      type: "setSelection",
      selection: { kind: "local", path: "/work" },
    });
    expect(transition(state, { type: "next" }).completed).toBe(true);
    expect(transition(createOnboardingFlowState("workspace"), { type: "skip" }).completed).toBe(
      true,
    );
  });

  it("FL-6: close marks the flow closed and invalid transitions preserve identity", () => {
    const state = createOnboardingFlowState();
    const closed = transition(state, { type: "close" });
    expect(closed.closed).toBe(true);
    expect(transition(closed, { type: "next" })).toBe(closed);
    expect(transition(state, { type: "next" })).toBe(state);
  });

  it("FL-K2/FL-K3: keyboard parser is covered separately and reducer back returns to prior step", () => {
    let state = createOnboardingFlowState();
    state = transition(state, { type: "setStepDone", step: "nek", done: true });
    state = transition(state, { type: "next" });
    expect(transition(state, { type: "back" }).currentStep).toBe("nek");
  });
});
