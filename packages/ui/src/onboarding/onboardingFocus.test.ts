import { describe, expect, it } from "vitest";
import { shouldTakeFocus } from "./onboardingFocus.js";

describe("onboarding focus policy", () => {
  it("common §4.2: does not steal focus from editable content or a selection", () => {
    expect(shouldTakeFocus({ editable: true, hasContent: true, hasSelection: false })).toBe(false);
    expect(shouldTakeFocus({ editable: true, hasContent: false, hasSelection: true })).toBe(false);
  });

  it("common §4.2: takes focus when the active element is empty or not editable", () => {
    expect(shouldTakeFocus({ editable: true, hasContent: false, hasSelection: false })).toBe(true);
    expect(shouldTakeFocus({ editable: false, hasContent: true, hasSelection: true })).toBe(true);
    expect(shouldTakeFocus(null)).toBe(true);
  });
});
