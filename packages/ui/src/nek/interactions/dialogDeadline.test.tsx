/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDialogDeadline } from "./dialogDeadline.js";

describe("extension dialog deadlines", () => {
  it("ED-T1/ED-T2: exposes remaining milliseconds, expires once, and cleans the ticker", () => {
    let now = 1_000;
    let tick: (() => void) | undefined;
    let cleared = false;
    const expired: string[] = [];
    const { result, unmount } = renderHook(() =>
      useDialogDeadline({
        timeout: 2_000,
        now: () => now,
        setIntervalFn: (callback) => {
          tick = callback;
          return callback;
        },
        clearIntervalFn: () => {
          cleared = true;
        },
        onExpired: () => expired.push("expired"),
      }),
    );
    expect(result.current.remainingMs).toBe(2_000);
    now = 2_999;
    act(() => tick?.());
    expect(result.current.remainingMs).toBe(1);
    now = 3_000;
    act(() => tick?.());
    act(() => tick?.());
    expect(expired).toEqual(["expired"]);
    unmount();
    expect(cleared).toBe(true);
  });
});
