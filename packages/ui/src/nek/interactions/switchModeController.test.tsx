/** @vitest-environment happy-dom */
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { NekSwitchModePayload } from "@zcode/shared/nek-protocol";
import { useSwitchModeController } from "./switchModeController.js";

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });
}

function payload(to: NekSwitchModePayload["to"], explanation?: string): NekSwitchModePayload {
  return {
    from: to === "plan" ? "agent" : "plan",
    to,
    ...(explanation === undefined ? {} : { explanation }),
  };
}

describe("switch_mode controller", () => {
  it("SM-1/SM-4: chooses safe default focus and omits blank explanation", () => {
    const { result } = renderHook(
      () =>
        useSwitchModeController({
          payload: payload("agent", "  "),
          onSubmit: () => undefined,
        }),
      { wrapper },
    );
    expect(result.current.view.explanation).toBeUndefined();
    expect(result.current.view.to).toBe("agent");
  });

  it("SM-A1/SM-A2/SM-5: action handles send the expected result and isolate pending", async () => {
    let resolve: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { result } = renderHook(
      () => useSwitchModeController({ payload: payload("plan"), onSubmit }),
      { wrapper },
    );
    await act(async () => {
      void result.current.actions.approve.run();
    });
    expect(result.current.actions.approve.pending).toBe(true);
    expect(result.current.actions.reject.pending).toBe(false);
    expect(result.current.actions.reject.disabledReason).toEqual({ id: "ui.action.busy" });
    resolve?.();
    await act(async () => undefined);
    expect(onSubmit).toHaveBeenCalledWith({ approved: true });
  });
});
