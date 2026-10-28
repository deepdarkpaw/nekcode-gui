/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { shouldTakeFocus, useInteractionFocus } from "./interactionCommon.js";

describe("interaction common focus rules", () => {
  it("00-common-F2: keeps focus in an editable element with content or selection", () => {
    expect(shouldTakeFocus({ isEditable: true, hasContent: true, hasSelection: false })).toBe(
      false,
    );
    expect(shouldTakeFocus({ isEditable: true, hasContent: false, hasSelection: true })).toBe(
      false,
    );
    expect(shouldTakeFocus({ isEditable: true, hasContent: false, hasSelection: false })).toBe(
      true,
    );
    expect(shouldTakeFocus({ isEditable: false, hasContent: true, hasSelection: true })).toBe(true);
  });

  it("00-common-F1/F4: focuses only a registered target and ignores disabled targets", () => {
    const frames: Array<FrameRequestCallback> = [];
    const { result } = renderHook(() =>
      useInteractionFocus({
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: () => undefined,
      }),
    );
    const button = document.createElement("button");
    document.body.append(button);
    act(() => {
      result.current.ref("primary")(button);
      result.current.setTarget("primary");
    });
    act(() => frames.shift()?.(0));
    expect(document.activeElement).toBe(button);
    button.setAttribute("disabled", "true");
    act(() => result.current.setTarget("primary"));
    act(() => frames.shift()?.(0));
    expect(document.activeElement).toBe(button);
  });
});
