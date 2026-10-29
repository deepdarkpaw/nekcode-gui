/** @vitest-environment happy-dom */
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { NekPlanReviewPayload } from "@zcode/shared/nek-protocol";
import { usePlanReviewController } from "./planReviewController.js";

const payload: NekPlanReviewPayload = {
  path: "/workspace/plan.md",
  revision: 2,
  name: "Plan",
  overview: "Overview",
  markdown: "# Body",
  todos: [],
};

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });
}

describe("plan review controller", () => {
  it.each([
    ["PR-A1: implement", "implement" as const, { action: "implement" }],
    ["PR-A2: implement fresh", "implement_fresh" as const, { action: "implement_fresh" }],
    ["PR-A3: keep planning", "keep_planning" as const, { action: "keep_planning" }],
    ["PR-A4: exit", "exit" as const, { action: "exit" }],
  ])("%s", async (_name, action, expected) => {
    const onSubmit = vi.fn(() => undefined);
    const { result } = renderHook(
      () =>
        usePlanReviewController({
          payload,
          onSubmit,
          onOpenPlanFile: () => undefined,
          focusComposer: () => undefined,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.actions[
        action === "implement_fresh"
          ? "implementFresh"
          : action === "keep_planning"
            ? "keepPlanning"
            : action
      ].run();
    });
    expect(onSubmit).toHaveBeenCalledWith(expected);
  });

  it("PR-A5/PR-K4: later cancels and returns focus to the composer", async () => {
    const onSubmit = vi.fn(() => undefined);
    const focusComposer = vi.fn();
    const { result } = renderHook(
      () =>
        usePlanReviewController({
          payload,
          onSubmit,
          onOpenPlanFile: () => undefined,
          focusComposer,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.actions.later.run();
    });
    expect(onSubmit).toHaveBeenCalledWith({ cancelled: true });
    expect(focusComposer).toHaveBeenCalledOnce();
  });

  it("PR-A6/PR-2.2: openFile does not close and toggleBody updates the fold projection", async () => {
    const onOpenPlanFile = vi.fn(() => undefined);
    const { result } = renderHook(
      () =>
        usePlanReviewController({
          payload,
          onSubmit: () => undefined,
          onOpenPlanFile,
          focusComposer: () => undefined,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.actions.openFile.run();
      await result.current.actions.toggleBody.run();
    });
    expect(onOpenPlanFile).toHaveBeenCalledWith(payload.path);
    expect(result.current.view.expanded).toBe(false);
    expect(result.current.view.bodyPreviewLines).toEqual(["# Body"]);
  });
});
