import { describe, expect, it } from "vitest";
import { buildSwitchModeResult } from "./structuredResults.js";
import { resolveSwitchModeKey } from "./switchModeKeyboard.js";
import { createSwitchModeState, reduceSwitchMode } from "./switchModeReducer.js";

function key(patch: Partial<Parameters<typeof resolveSwitchModeKey>[0]>) {
  return { key: "?", focusTarget: "card" as const, ...patch };
}

describe("switch_mode", () => {
  it("SM-A1/SM-A2: builds approval and rejection results", () => {
    expect(buildSwitchModeResult(true)).toEqual({ approved: true });
    expect(buildSwitchModeResult(false)).toEqual({ approved: false });
  });

  it("SM-1/SM-4/SM-5: state closes and ignores duplicate transitions", () => {
    const initial = createSwitchModeState();
    const closed = reduceSwitchMode(initial, { type: "close" });
    expect(reduceSwitchMode(closed, { type: "close" })).toBe(closed);
    expect(
      reduceSwitchMode(initial, { type: "submit", event: { type: "start" } }).submit.status,
    ).toBe("pending");
  });

  it("SM-K2/SM-K3: buttons keep native Enter/Space and Escape rejects", () => {
    expect(resolveSwitchModeKey(key({ key: "Enter", focusTarget: "button" }))).toBeNull();
    expect(resolveSwitchModeKey(key({ key: " " }))).toBeNull();
    expect(resolveSwitchModeKey(key({ key: "Escape" }))).toBe("reject");
  });

  it("SM-K1/SM-K4: IME and modifier Escape are not handled", () => {
    expect(resolveSwitchModeKey(key({ key: "Escape", isComposing: true }))).toBeNull();
    expect(resolveSwitchModeKey(key({ key: "Escape", keyCode: 229 }))).toBeNull();
    expect(resolveSwitchModeKey(key({ key: "Escape", ctrlKey: true }))).toBeNull();
  });
});
