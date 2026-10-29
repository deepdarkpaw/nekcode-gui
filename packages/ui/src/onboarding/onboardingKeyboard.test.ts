import { describe, expect, it } from "vitest";
import { resolveOnboardingKey, type OnboardingKeyInput } from "./onboardingKeyboard.js";

const base: OnboardingKeyInput = {
  key: "",
  childDialogOpen: false,
  canBack: true,
  canNext: true,
  installing: false,
};

describe("onboarding keyboard resolver", () => {
  it.each([
    ["FL-K2: Alt+Left goes back", { key: "ArrowLeft", altKey: true }, "back"],
    ["FL-K2: Alt+Right goes next", { key: "ArrowRight", altKey: true }, "next"],
    ["FL-K3: Escape closes the outer flow", { key: "Escape" }, "close"],
  ])("%s", (_name, input, command) => {
    expect(resolveOnboardingKey({ ...base, ...input })).toBe(command);
  });

  it.each([
    ["FL-K1: Enter is delegated to the focused button", "Enter"],
    ["FL-K1: Space is delegated to the focused button", " "],
    ["common §3: an unlisted key is ignored", "Tab"],
  ])("%s", (_name, key) => {
    expect(resolveOnboardingKey({ ...base, key })).toBeNull();
  });

  it.each([
    ["FL-K2: unavailable back is ignored", { key: "ArrowLeft", altKey: true, canBack: false }],
    ["FL-K2: unavailable next is ignored", { key: "ArrowRight", altKey: true, canNext: false }],
    ["FL-K3: child dialog owns Escape", { key: "Escape", childDialogOpen: true }],
    ["FL-K3: installation owns Escape", { key: "Escape", installing: true }],
  ])("%s", (_name, input) => {
    expect(resolveOnboardingKey({ ...base, ...input })).toBeNull();
  });

  it.each([
    ["common §3: isComposing", { isComposing: true }],
    ["common §3: keyCode 229", { keyCode: 229 }],
  ])("%s", (_name, input) => {
    expect(resolveOnboardingKey({ ...base, key: "Escape", ...input })).toBeNull();
  });
});
