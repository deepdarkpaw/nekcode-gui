/** @vitest-environment happy-dom */
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useSelectDialogController } from "./selectDialogController.js";
import { useConfirmDialogController } from "./confirmDialogController.js";
import { useInputDialogController } from "./inputDialogController.js";
import { useEditorDialogController } from "./editorDialogController.js";

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });
}

describe("extension dialog controllers", () => {
  it("ED-S5: select click responds with the selected value and cancel is available", async () => {
    const onRespond = vi.fn(() => undefined);
    const { result } = renderHook(
      () =>
        useSelectDialogController({
          request: {
            type: "extension_ui_request",
            id: "s",
            method: "select",
            title: "Select",
            options: ["A", "B"],
          },
          onRespond,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.select(1);
    });
    expect(onRespond).toHaveBeenCalledWith({ type: "extension_ui_response", id: "s", value: "B" });
    expect(result.current.actions.cancel.visible).toBe(true);
  });

  it("ED-C1/ED-C2/ED-C3: confirm actions send true/false and default focus is cancel", async () => {
    const onRespond = vi.fn(() => undefined);
    const { result } = renderHook(
      () =>
        useConfirmDialogController({
          request: {
            type: "extension_ui_request",
            id: "c",
            method: "confirm",
            title: "Continue",
            message: "Go?",
          },
          onRespond,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.actions.confirm.run();
    });
    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "c",
      confirmed: true,
    });
  });

  it("ED-I1/ED-I2: input submits text and permits an empty value", async () => {
    const onRespond = vi.fn(() => undefined);
    const { result } = renderHook(
      () =>
        useInputDialogController({
          request: { type: "extension_ui_request", id: "i", method: "input", title: "Input" },
          onRespond,
        }),
      { wrapper },
    );
    await act(async () => {
      await result.current.actions.submit.run();
    });
    expect(onRespond).toHaveBeenCalledWith({ type: "extension_ui_response", id: "i", value: "" });
  });

  it("ED-E1/ED-E2/ED-E3: editor preserves dirty text until discard is explicit", async () => {
    const onRespond = vi.fn(() => undefined);
    const { result } = renderHook(
      () =>
        useEditorDialogController({
          request: {
            type: "extension_ui_request",
            id: "e",
            method: "editor",
            title: "Edit",
            prefill: "before",
          },
          onRespond,
          onLostText: () => undefined,
        }),
      { wrapper },
    );
    act(() => result.current.setText("after"));
    await act(async () => {
      await result.current.actions.cancel.run();
    });
    expect(result.current.view.confirmDiscard).toBe(true);
    expect(onRespond).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.actions.discard.run();
    });
    expect(onRespond).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "e",
      cancelled: true,
    });
  });
});
