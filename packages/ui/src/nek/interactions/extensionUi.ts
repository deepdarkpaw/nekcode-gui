import type {
  NekExtensionUiDialogRequest,
  NekExtensionUiFireAndForgetRequest,
  NekExtensionUiRequest,
  NekExtensionUiResponse,
  NekStructuredUiRequest,
} from "@zcode/shared/nek-protocol";

export type NekExtensionUiRequestKind = "dialog" | "structured" | "fire-and-forget";

export type NekExtensionUiEffect =
  | {
      kind: "notify";
      id: string;
      message: string;
      notifyType: "info" | "warning" | "error";
    }
  | {
      kind: "status";
      id: string;
      statusKey: string;
      statusText?: string;
    }
  | {
      kind: "widget";
      id: string;
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement: "aboveEditor" | "belowEditor";
    }
  | { kind: "title"; id: string; title: string }
  | { kind: "editor-text"; id: string; text: string };

export function isNekExtensionUiDialogRequest(
  request: NekExtensionUiRequest,
): request is NekExtensionUiDialogRequest {
  return (
    request.method === "select" ||
    request.method === "confirm" ||
    request.method === "input" ||
    request.method === "editor"
  );
}

export function isNekExtensionUiFireAndForgetRequest(
  request: NekExtensionUiRequest,
): request is NekExtensionUiFireAndForgetRequest {
  return (
    request.method === "notify" ||
    request.method === "setStatus" ||
    request.method === "setWidget" ||
    request.method === "setTitle" ||
    request.method === "set_editor_text"
  );
}

export function isNekStructuredUiRequest(
  request: NekExtensionUiRequest,
): request is NekStructuredUiRequest {
  return request.method === "structured";
}

export function classifyNekExtensionUiRequest(
  request: NekExtensionUiRequest,
): NekExtensionUiRequestKind {
  if (isNekStructuredUiRequest(request)) return "structured";
  if (isNekExtensionUiDialogRequest(request)) return "dialog";
  if (isNekExtensionUiFireAndForgetRequest(request)) return "fire-and-forget";
  throw new Error(`Unsupported extension UI method: ${String(request.method)}.`);
}

/** Convert a fire-and-forget wire request to a stable store event. */
export function toNekExtensionUiEffect(
  request: NekExtensionUiFireAndForgetRequest,
): NekExtensionUiEffect {
  switch (request.method) {
    case "notify":
      return {
        kind: "notify",
        id: request.id,
        message: request.message,
        notifyType: request.notifyType ?? "info",
      };
    case "setStatus":
      return {
        kind: "status",
        id: request.id,
        statusKey: request.statusKey,
        ...(request.statusText === undefined ? {} : { statusText: request.statusText }),
      };
    case "setWidget":
      return {
        kind: "widget",
        id: request.id,
        widgetKey: request.widgetKey,
        ...(request.widgetLines === undefined ? {} : { widgetLines: [...request.widgetLines] }),
        widgetPlacement: request.widgetPlacement ?? "aboveEditor",
      };
    case "setTitle":
      return { kind: "title", id: request.id, title: request.title };
    case "set_editor_text":
      return { kind: "editor-text", id: request.id, text: request.text };
  }
}

export function buildDialogResponse(
  request: NekExtensionUiDialogRequest,
  value: string | boolean,
): NekExtensionUiResponse {
  if (request.method === "confirm") {
    if (typeof value !== "boolean") throw new Error("A confirm dialog requires a boolean.");
    return { type: "extension_ui_response", id: request.id, confirmed: value };
  }
  if (typeof value !== "string") throw new Error(`${request.method} requires a string.`);
  return { type: "extension_ui_response", id: request.id, value };
}

export function buildCancelledExtensionUiResponse(id: string): NekExtensionUiResponse {
  return { type: "extension_ui_response", id, cancelled: true };
}
