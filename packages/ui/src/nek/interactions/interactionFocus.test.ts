import { describe, expect, it } from "vitest";
import {
  checkActionBindingConflict,
  resolveEffectiveActionBindings,
} from "@/shortcuts/actionRegistry.js";
import { focusInteractionQueue, resolveInteractionFocusAction } from "./interactionFocus.js";

describe("interaction focus shortcut", () => {
  const effective = resolveEffectiveActionBindings();
  const event = (patch: Partial<Parameters<typeof resolveInteractionFocusAction>[0]> = {}) => ({
    key: "i",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: true,
    ...patch,
  });

  it("MQ-7: Alt+I focuses a pending queue and does nothing when empty", () => {
    expect(resolveInteractionFocusAction(event(), true, effective)).toBe("focus");
    expect(resolveInteractionFocusAction(event(), false, effective)).toBeNull();
    expect(resolveInteractionFocusAction(event({ altKey: false }), true, effective)).toBeNull();
  });

  it("MQ-7: delegates default focus exactly once", () => {
    let focused = 0;
    expect(focusInteractionQueue(true, () => focused++)).toBe(true);
    expect(focused).toBe(1);
    expect(focusInteractionQueue(false, () => focused++)).toBe(false);
    expect(focused).toBe(1);
  });

  it("MQ-7: Alt+I has no binding conflict", () => {
    expect(checkActionBindingConflict("gui.interaction.focus", "Alt+i", effective)).toBeNull();
  });
});
