import { describe, expect, it } from "vitest";
import type { NekExtensionUiRequest } from "@zcode/shared/nek-protocol";
import {
  buildCancelledExtensionUiResponse,
  buildDialogResponse,
  classifyNekExtensionUiRequest,
  toNekExtensionUiEffect,
} from "./extensionUi.js";

describe("extension UI request classification and effects", () => {
  it("ED-0/FF-0: classifies all dialog, structured, and fire-and-forget methods", () => {
    const requests: Array<[NekExtensionUiRequest, string]> = [
      [
        { type: "extension_ui_request", id: "s", method: "select", title: "s", options: [] },
        "dialog",
      ],
      [
        { type: "extension_ui_request", id: "c", method: "confirm", title: "c", message: "m" },
        "dialog",
      ],
      [{ type: "extension_ui_request", id: "i", method: "input", title: "i" }, "dialog"],
      [{ type: "extension_ui_request", id: "e", method: "editor", title: "e" }, "dialog"],
      [
        {
          type: "extension_ui_request",
          id: "q",
          method: "structured",
          kind: "nek.ask_question",
          payload: {},
        },
        "structured",
      ],
      [
        { type: "extension_ui_request", id: "n", method: "notify", message: "m" },
        "fire-and-forget",
      ],
      [
        { type: "extension_ui_request", id: "st", method: "setStatus", statusKey: "k" },
        "fire-and-forget",
      ],
      [
        { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "k" },
        "fire-and-forget",
      ],
      [
        { type: "extension_ui_request", id: "t", method: "setTitle", title: "t" },
        "fire-and-forget",
      ],
      [
        { type: "extension_ui_request", id: "x", method: "set_editor_text", text: "x" },
        "fire-and-forget",
      ],
    ];
    for (const [request, kind] of requests)
      expect(classifyNekExtensionUiRequest(request)).toBe(kind);
  });

  it("ED-0: builds each dialog wire response and cancellation", () => {
    expect(
      buildDialogResponse(
        { type: "extension_ui_request", id: "s", method: "select", title: "s", options: [] },
        "A",
      ),
    ).toMatchObject({ id: "s", value: "A" });
    expect(
      buildDialogResponse(
        { type: "extension_ui_request", id: "c", method: "confirm", title: "c", message: "m" },
        true,
      ),
    ).toMatchObject({ id: "c", confirmed: true });
    expect(
      buildDialogResponse(
        { type: "extension_ui_request", id: "i", method: "input", title: "i" },
        "text",
      ),
    ).toMatchObject({ id: "i", value: "text" });
    expect(
      buildDialogResponse(
        { type: "extension_ui_request", id: "e", method: "editor", title: "e" },
        "text",
      ),
    ).toMatchObject({ id: "e", value: "text" });
    expect(buildCancelledExtensionUiResponse("x")).toEqual({
      type: "extension_ui_response",
      id: "x",
      cancelled: true,
    });
  });

  it("FF-1: notify maps notifyType to a toast level and defaults to info", () => {
    expect(
      toNekExtensionUiEffect({
        type: "extension_ui_request",
        id: "n",
        method: "notify",
        message: "warn",
        notifyType: "warning",
      }),
    ).toEqual({ kind: "toast", id: "n", message: "warn", level: "warning" });
    expect(
      toNekExtensionUiEffect({
        type: "extension_ui_request",
        id: "n2",
        method: "notify",
        message: "info",
      }),
    ).toMatchObject({ level: "info" });
  });

  it("FF-2/FF-3/FF-4/FF-5: maps status, widget, title, and composer replacement", () => {
    expect(
      toNekExtensionUiEffect({
        type: "extension_ui_request",
        id: "s",
        method: "setStatus",
        statusKey: "k",
      }),
    ).toEqual({ kind: "setStatus", id: "s", statusKey: "k" });
    expect(
      toNekExtensionUiEffect({
        type: "extension_ui_request",
        id: "w",
        method: "setWidget",
        widgetKey: "k",
        widgetLines: ["x"],
        widgetPlacement: "belowEditor",
      }),
    ).toEqual({
      kind: "setWidget",
      id: "w",
      widgetKey: "k",
      widgetLines: ["x"],
      widgetPlacement: "belowEditor",
    });
    expect(
      toNekExtensionUiEffect({
        type: "extension_ui_request",
        id: "t",
        method: "setTitle",
        title: "title",
      }),
    ).toEqual({ kind: "setTitle", id: "t", title: "title" });
    expect(
      toNekExtensionUiEffect({
        type: "extension_ui_request",
        id: "x",
        method: "set_editor_text",
        text: "text",
      }),
    ).toEqual({ kind: "replaceComposerText", id: "x", text: "text" });
  });
});
