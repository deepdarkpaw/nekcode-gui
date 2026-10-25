import { describe, expect, it } from "vitest";
import { isImeComposing } from "./imeComposition.js";

describe("isImeComposing", () => {
  it("detects composition through isComposing on native or synthetic events", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
  });

  it("detects composition through keyCode 229", () => {
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });

  it("does not flag ordinary keys", () => {
    expect(isImeComposing({ keyCode: 13, isComposing: false })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });
});
