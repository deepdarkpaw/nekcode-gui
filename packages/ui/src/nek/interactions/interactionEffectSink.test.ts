import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NekExtensionUiFireAndForgetRequest } from "@zcode/shared/nek-protocol";
import { drainNekInteractionEffects } from "./interactionEffectSink.js";
import { createNekInteractionStore } from "./interactionStore.js";

function notifyRequest(
  id: string,
  message: string,
  notifyType?: "info" | "warning" | "error",
): NekExtensionUiFireAndForgetRequest {
  return {
    type: "extension_ui_request",
    id,
    method: "notify",
    message,
    ...(notifyType === undefined ? {} : { notifyType }),
  };
}

describe("Nek interaction effect sink", () => {
  let store: ReturnType<typeof createNekInteractionStore>;
  let notify: ReturnType<typeof vi.fn<(message: string, level: string) => void>>;
  let replaceComposerText: ReturnType<typeof vi.fn<(text: string) => void>>;
  let warnSpy: ReturnType<typeof vi.fn<(message: string, context?: unknown) => void>>;
  const formatMessage = (id: string) => `i18n:${id}`;

  function drain(options: { withComposer?: boolean } = {}) {
    return drainNekInteractionEffects({
      store,
      sessionKey: "session-a",
      formatMessage,
      notify,
      logger: { warn: warnSpy },
      ...(options.withComposer === false ? {} : { replaceComposerText }),
    });
  }

  beforeEach(() => {
    store = createNekInteractionStore({ respond: vi.fn(), onEffect: vi.fn() });
    notify = vi.fn<(message: string, level: string) => void>();
    replaceComposerText = vi.fn<(text: string) => void>();
    warnSpy = vi.fn<(message: string, context?: unknown) => void>();
  });

  it("FF notify: surfaces the message through the injected toast with its level", () => {
    store.getState().handleFireAndForget("session-a", notifyRequest("n1", "Heads up", "warning"));

    expect(drain()).toBe(1);
    expect(notify).toHaveBeenCalledWith("Heads up", "warning");
  });

  it("FF notify: defaults to the info level and keeps error visible as error", () => {
    store.getState().handleFireAndForget("session-a", notifyRequest("n1", "plain"));
    store.getState().handleFireAndForget("session-a", notifyRequest("n2", "bad", "error"));

    drain();
    expect(notify).toHaveBeenNthCalledWith(1, "plain", "info");
    expect(notify).toHaveBeenNthCalledWith(2, "bad", "error");
  });

  it("FF set_editor_text: replaces the composer text through the injected insert", () => {
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "e1",
      method: "set_editor_text",
      text: "prefilled",
    });

    drain();
    expect(replaceComposerText).toHaveBeenCalledWith("prefilled");
    expect(notify).not.toHaveBeenCalled();
  });

  it("FF set_editor_text: without a composer host the drop is logged, not silent", () => {
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "e1",
      method: "set_editor_text",
      text: "prefilled",
    });

    drain({ withComposer: false });
    expect(replaceComposerText).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[NekInteractionStore] set_editor_text without a composer host",
      { sessionKey: "session-a", id: "e1" },
    );
  });

  it("FF setStatus/setWidget/setTitle: update session state without inventing a toast", () => {
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "s1",
      method: "setStatus",
      statusKey: "mode",
      statusText: "plan",
    });
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
      widgetKey: "widget",
      widgetLines: ["line one", "line two"],
    });
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "t1",
      method: "setTitle",
      title: "Renamed",
    });

    expect(drain()).toBe(3);
    expect(notify).not.toHaveBeenCalled();
    const session = store.getState().sessions["session-a"];
    expect(session?.statuses).toEqual({ mode: "plan" });
    expect(session?.widgets.widget?.lines).toEqual(["line one", "line two"]);
    expect(session?.titleOverride).toBe("Renamed");
  });

  it("notices: the one-shot notices are localized and drained exactly once", () => {
    store.getState().enqueue("session-a", {
      type: "extension_ui_request",
      id: "gone",
      method: "input",
      title: "Which file?",
    });
    // 后端已经不认识这条请求：卡片移除并留下一次性提示（00-common §5.2）。
    expect(store.getState().cancelStaleById("gone")).toBe(true);

    expect(drain()).toBe(1);
    expect(notify).toHaveBeenCalledWith("i18n:nek.interaction.cancelledByHost", "info");
    expect(drain()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drain is bounded: a second call on an empty session is a no-op", () => {
    store.getState().handleFireAndForget("session-a", notifyRequest("n1", "only once"));

    expect(drain()).toBe(1);
    expect(drain()).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
