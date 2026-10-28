import { beforeEach, describe, expect, it } from "vitest";
import type {
  NekExtensionUiDialogRequest,
  NekExtensionUiFireAndForgetRequest,
} from "@zcode/shared/nek-protocol";
import { createNekInteractionStore } from "./interactionStore.js";

function inputRequest(id: string, timeout?: number): NekExtensionUiDialogRequest {
  return {
    type: "extension_ui_request",
    id,
    method: "input",
    title: id,
    ...(timeout === undefined ? {} : { timeout }),
  };
}

describe("NekInteractionStore", () => {
  let now: number;
  let store: ReturnType<typeof createNekInteractionStore>;
  let responses: unknown[];
  let effects: unknown[];
  let interval: (() => void) | undefined;

  beforeEach(() => {
    now = 1_000;
    responses = [];
    effects = [];
    interval = undefined;
    store = createNekInteractionStore({
      now: () => now,
      respond: (_session, response) => responses.push(response),
      onEffect: (_session, effect) => effects.push(effect),
      setIntervalFn: (callback) => {
        interval = callback;
        return callback;
      },
      clearIntervalFn: () => {
        interval = undefined;
      },
    });
  });

  it("MQ-1/MQ-2: enqueues one FIFO queue per session", () => {
    expect(store.getState().enqueue("session-a", inputRequest("a"))).toBe(true);
    expect(store.getState().enqueue("session-a", inputRequest("b"))).toBe(true);
    expect(store.getState().enqueue("session-b", inputRequest("other"))).toBe(true);
    expect(store.getState().getHead("session-a")?.request.id).toBe("a");
    expect(store.getState().sessions["session-a"]?.queue).toHaveLength(2);
  });

  it("MQ-3: host cancel removes a request without responding", () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    expect(store.getState().cancelById("a")).toBe(true);
    expect(responses).toHaveLength(0);
    expect(store.getState().getHead("session-a")).toBeUndefined();
  });

  it("MQ-6: disconnect clears the session without sending an answer", () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    store.getState().disconnect("session-a");
    expect(store.getState().sessions["session-a"]).toBeUndefined();
    expect(responses).toHaveLength(0);
  });

  it("00-common-5.3/MQ-5: refreshes a deadline and answers cancellation at timeout", () => {
    store.getState().enqueue("session-a", inputRequest("a", 2_000));
    now = 2_999;
    interval?.();
    expect(store.getState().getRemainingMs("session-a", "a")).toBe(1);
    expect(responses).toHaveLength(0);
    now = 3_000;
    interval?.();
    expect(responses).toEqual([{ type: "extension_ui_response", id: "a", cancelled: true }]);
    expect(store.getState().getHead("session-a")).toBeUndefined();
  });

  it("00-common-5.5: ignores a late settle after host cancellation", () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    store.getState().cancelByHost("session-a", "a");
    expect(
      store.getState().settle("session-a", "a", {
        type: "extension_ui_response",
        id: "a",
        value: "late",
      }),
    ).toBe(false);
    expect(responses).toHaveLength(0);
  });

  it("FF-1/FF-2/FF-3: applies bounded fire-and-forget state and emits effects", () => {
    const status: NekExtensionUiFireAndForgetRequest = {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "build",
      statusText: "running",
    };
    const widget: NekExtensionUiFireAndForgetRequest = {
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "build",
      widgetLines: Array.from({ length: 51 }, (_, index) => String(index)),
    };
    store.getState().handleFireAndForget("session-a", status);
    store.getState().handleFireAndForget("session-a", widget);
    expect(store.getState().sessions["session-a"]?.statuses).toEqual({ build: "running" });
    expect(store.getState().sessions["session-a"]?.widgets.build).toMatchObject({
      truncated: true,
      lines: expect.arrayContaining(["0", "49"]),
    });
    expect(effects).toHaveLength(2);
  });

  it("FF-2/FF-3: empty status and omitted widget lines delete state", () => {
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "s1",
      method: "setStatus",
      statusKey: "x",
      statusText: "value",
    });
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "s2",
      method: "setStatus",
      statusKey: "x",
    });
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "w1",
      method: "setWidget",
      widgetKey: "x",
      widgetLines: ["value"],
    });
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "w2",
      method: "setWidget",
      widgetKey: "x",
    });
    expect(store.getState().sessions["session-a"]?.statuses).toEqual({});
    expect(store.getState().sessions["session-a"]?.widgets).toEqual({});
  });

  it("cleans the shared deadline ticker after the last request closes", () => {
    store.getState().enqueue("session-a", inputRequest("a", 2_000));
    store.getState().cancelByUser("session-a", "a");
    expect(interval).toBeUndefined();
    store.getState().shutdown();
  });
});
