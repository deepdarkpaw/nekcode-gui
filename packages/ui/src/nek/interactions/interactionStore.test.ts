import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("FF-4/FF-5: setTitle clears on empty and set_editor_text emits replacement", () => {
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "title-1",
      method: "setTitle",
      title: "Build",
    });
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "title-2",
      method: "setTitle",
      title: "",
    });
    store.getState().handleFireAndForget("session-a", {
      type: "extension_ui_request",
      id: "text-1",
      method: "set_editor_text",
      text: "prefill",
    });
    expect(store.getState().sessions["session-a"]?.titleOverride).toBeUndefined();
    expect(effects).toEqual([
      { kind: "setTitle", id: "title-1", title: "Build" },
      { kind: "setTitle", id: "title-2", title: "" },
      { kind: "replaceComposerText", id: "text-1", text: "prefill" },
    ]);
  });

  it("FF-2: status keys are bounded and evict the oldest key", () => {
    for (let index = 0; index < 33; index += 1) {
      store.getState().handleFireAndForget("session-a", {
        type: "extension_ui_request",
        id: `status-${index}`,
        method: "setStatus",
        statusKey: `key-${index}`,
        statusText: String(index),
      });
    }
    const statuses = store.getState().sessions["session-a"]?.statuses ?? {};
    expect(Object.keys(statuses)).toHaveLength(32);
    expect(statuses["key-0"]).toBeUndefined();
    expect(statuses["key-32"]).toBe("32");
  });

  it("FF-3: widgets are bounded to 16 keys and 50 lines with truncation metadata", () => {
    for (let index = 0; index < 17; index += 1) {
      store.getState().handleFireAndForget("session-a", {
        type: "extension_ui_request",
        id: `widget-${index}`,
        method: "setWidget",
        widgetKey: `key-${index}`,
        widgetLines: Array.from({ length: 51 }, (_, line) => `${index}-${line}`),
      });
    }
    const widgets = store.getState().sessions["session-a"]?.widgets ?? {};
    expect(Object.keys(widgets)).toHaveLength(16);
    expect(widgets["key-0"]).toBeUndefined();
    expect(widgets["key-16"]).toMatchObject({ truncated: true, lines: expect.any(Array) });
    expect(widgets["key-16"]?.lines).toHaveLength(50);
  });

  it("cleans the shared deadline ticker after the last request closes", () => {
    store.getState().enqueue("session-a", inputRequest("a", 2_000));
    store.getState().cancelByUser("session-a", "a");
    expect(interval).toBeUndefined();
    store.getState().shutdown();
  });

  it("settleAsync answers first and only then closes the request", async () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    const responder = vi.fn(async () => undefined);
    await expect(
      store
        .getState()
        .settleAsync(
          "session-a",
          "a",
          { type: "extension_ui_response", id: "a", value: "v" },
          responder,
        ),
    ).resolves.toBe(true);
    expect(responder).toHaveBeenCalledWith("session-a", {
      type: "extension_ui_response",
      id: "a",
      value: "v",
    });
    expect(store.getState().getHead("session-a")).toBeUndefined();
    expect(responses).toHaveLength(0);
  });

  it("settleAsync keeps the request and its draft when delivery fails", async () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    store.getState().updateDraft("session-a", "a", { text: "draft" });
    await expect(
      store
        .getState()
        .settleAsync(
          "session-a",
          "a",
          { type: "extension_ui_response", id: "a", value: "v" },
          async () => {
            throw new Error("transport down");
          },
        ),
    ).rejects.toThrow("transport down");
    expect(store.getState().getHead("session-a")?.request.id).toBe("a");
    expect(store.getState().sessions["session-a"]?.drafts.a).toEqual({ text: "draft" });
  });

  it("settleAsync only submits once while the first answer is in flight", async () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    let release: (() => void) | undefined;
    const responder = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = store
      .getState()
      .settleAsync(
        "session-a",
        "a",
        { type: "extension_ui_response", id: "a", value: "1" },
        responder,
      );
    await expect(
      store
        .getState()
        .settleAsync(
          "session-a",
          "a",
          { type: "extension_ui_response", id: "a", value: "2" },
          responder,
        ),
    ).resolves.toBe(false);
    release?.();
    await expect(first).resolves.toBe(true);
    expect(responder).toHaveBeenCalledOnce();
  });

  it("settleAsync still succeeds when the host cancels while the answer is in flight", async () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    await expect(
      store
        .getState()
        .settleAsync(
          "session-a",
          "a",
          { type: "extension_ui_response", id: "a", value: "v" },
          async () => {
            store.getState().cancelByHost("session-a", "a");
          },
        ),
    ).resolves.toBe(true);
    expect(store.getState().getHead("session-a")).toBeUndefined();
  });

  it("cancelStaleById removes the request and leaves one bounded notice", () => {
    store.getState().enqueue("session-a", inputRequest("a"));
    expect(store.getState().cancelStaleById("a")).toBe(true);
    expect(store.getState().getHead("session-a")).toBeUndefined();
    expect(store.getState().cancelStaleById("a")).toBe(false);
    expect(store.getState().sessions["session-a"]?.notices).toEqual([
      { requestId: "a", id: "nek.interaction.cancelledByHost" },
    ]);
    expect(store.getState().sessions["session-a"]?.closedRequestIds).toContain("a");
  });

  it("keeps notices bounded when many requests go stale", () => {
    for (let index = 0; index < 12; index += 1) {
      const id = `stale-${index}`;
      store.getState().enqueue("session-a", inputRequest(id));
      store.getState().cancelStaleById(id);
    }
    expect(store.getState().sessions["session-a"]?.notices).toHaveLength(8);
    expect(store.getState().takeNotices("session-a")).toHaveLength(8);
    expect(store.getState().sessions["session-a"]?.notices).toEqual([]);
  });
});
