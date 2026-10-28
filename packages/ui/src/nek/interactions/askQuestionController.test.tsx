/** @vitest-environment happy-dom */
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NekAskQuestionPayload } from "@zcode/shared/nek-protocol";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useAskQuestionController } from "./askQuestionController.js";

const payload: NekAskQuestionPayload = {
  questions: [
    {
      id: "question",
      prompt: "Choose",
      options: [{ id: "one", label: "One" }],
    },
  ],
};

describe("ask_question controller", () => {
  it("AQ-2.3: only the operation being executed reports pending while the peer is busy", async () => {
    let resolveDismiss: (() => void) | undefined;
    const { result } = renderHook(
      () =>
        useAskQuestionController({
          payload,
          onSubmit: () => undefined,
          onDismiss: () =>
            new Promise<void>((resolve) => {
              resolveDismiss = resolve;
            }),
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children }),
      },
    );

    await act(async () => {
      void result.current.actions.dismiss.run();
    });
    expect(result.current.actions.dismiss.pending).toBe(true);
    expect(result.current.actions.primary.pending).toBe(false);
    expect(result.current.actions.primary.enabled).toBe(false);
    expect(result.current.actions.primary.disabledReason).toEqual({ id: "ui.action.busy" });

    await act(async () => {
      resolveDismiss?.();
    });
  });
});
