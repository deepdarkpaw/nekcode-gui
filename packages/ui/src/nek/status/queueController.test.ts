// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNekStatusStore } from "./store.js";
import { intlWrapper } from "./controllerTestUtils.js";
import { useQueueBarController } from "./useQueueBarController.js";

beforeEach(() => {
  vi.useFakeTimers();
  useNekStatusStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setQueue(steering: string[], followUp: string[]) {
  useNekStatusStore.getState().consumeEvent("s", { type: "queue_update", steering, followUp }, 0);
}

function props(overrides: Partial<Parameters<typeof useQueueBarController>[0]> = {}) {
  let draft = "draft";
  return {
    sessionKey: "s",
    clearQueue: vi.fn(async () => ({ steering: ["same", "same"], followUp: ["later"] })),
    requeue: vi.fn(async () => undefined),
    getComposerText: () => draft,
    setComposerText: (next: string) => {
      draft = next;
    },
    focusComposerAtEnd: vi.fn(),
    ...overrides,
  };
}

type QueueKeyDownEvent = Parameters<ReturnType<typeof useQueueBarController>["onKeyDown"]>[0];

/** 控制器只看 key/修饰键/IME 与 preventDefault，用最小事件替身驱动键盘语义。 */
function keyEvent(init: {
  key: string;
  shiftKey?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): QueueKeyDownEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key: init.key,
    altKey: false,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: false,
    metaKey: false,
    keyCode: 0,
    nativeEvent: { isComposing: false, keyCode: 0, ...init.nativeEvent },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as QueueKeyDownEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

describe("queue bar controller", () => {
  it("QB-1: exposes ordered steering/follow-up items and retrieves all into the draft", async () => {
    setQueue(["urgent"], ["later"]);
    const input = props();
    const { result } = renderHook(() => useQueueBarController(input), { wrapper: intlWrapper });
    expect(result.current.view.items.map((item) => [item.kind, item.text])).toEqual([
      ["steering", "urgent"],
      ["followUp", "later"],
    ]);
    await act(async () => await result.current.actions.retrieveAll.run());
    expect(input.setComposerText).toBeDefined();
    expect(input.focusComposerAtEnd).toHaveBeenCalled();
    expect(input.clearQueue).toHaveBeenCalledTimes(1);
  });

  it("QB-2/QB-3: edits and deletes through clear_queue then requeues the computed result", async () => {
    setQueue(["same", "same"], ["later"]);
    const input = props();
    const { result } = renderHook(() => useQueueBarController(input), { wrapper: intlWrapper });
    await act(async () => await result.current.view.items[1]?.edit.run());
    act(() => result.current.setDraft("edited"));
    await act(async () => await result.current.commitEdit());
    expect(input.requeue).toHaveBeenCalledWith({
      steering: ["same", "edited"],
      followUp: ["later"],
    });
    await act(async () => await result.current.view.items[0]?.delete.run());
    expect(input.requeue).toHaveBeenCalledWith({ steering: ["same"], followUp: ["later"] });
  });

  it("QB-4: rejects blank edits and keeps editing open", async () => {
    setQueue(["message"], []);
    const input = props({
      clearQueue: vi.fn(async () => ({ steering: ["message"], followUp: [] })),
    });
    const { result } = renderHook(() => useQueueBarController(input), { wrapper: intlWrapper });
    await act(async () => await result.current.view.items[0]?.edit.run());
    act(() => result.current.setDraft("  "));
    await act(async () => await result.current.commitEdit());
    expect(result.current.view.editing?.validationError?.id).toBe("nek.status.queue.emptyText");
    expect(input.clearQueue).not.toHaveBeenCalled();
  });

  it("QB-5: returns consumed without losing the actual queue", async () => {
    setQueue(["old"], []);
    const input = props({ clearQueue: vi.fn(async () => ({ steering: ["new"], followUp: [] })) });
    const { result } = renderHook(() => useQueueBarController(input), { wrapper: intlWrapper });
    await act(async () => await result.current.view.items[0]?.delete.run());
    expect(input.requeue).toHaveBeenCalledWith({ steering: ["new"], followUp: [] });
    expect(result.current.view.editing).toBeNull();
  });

  it("QB-K3: dequeue shortcut returns false when empty and true when queued", async () => {
    const input = props();
    const { result } = renderHook(() => useQueueBarController(input), { wrapper: intlWrapper });
    expect(await result.current.onDequeueShortcut()).toBe(false);
    act(() => setQueue(["one"], []));
    let handled = false;
    await act(async () => {
      handled = await result.current.onDequeueShortcut();
    });
    expect(handled).toBe(true);
  });

  it("QB-K4: Enter submits the multiline draft, Shift+Enter and IME composition do not", async () => {
    setQueue(["第一行"], []);
    const input = props({
      clearQueue: vi.fn(async () => ({ steering: ["第一行"], followUp: [] })),
    });
    const { result } = renderHook(() => useQueueBarController(input), { wrapper: intlWrapper });
    await act(async () => await result.current.view.items[0]?.edit.run());
    act(() => result.current.setDraft("  "));
    const shiftEnter = keyEvent({ key: "Enter", shiftKey: true });
    act(() => result.current.onKeyDown(shiftEnter));
    expect(shiftEnter.preventDefault).not.toHaveBeenCalled();
    // 空内容才走同步校验，借此观察"Enter 是否真的提交了"。
    const enter = keyEvent({ key: "Enter" });
    act(() => result.current.onKeyDown(enter));
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(result.current.view.editing?.validationError?.id).toBe("nek.status.queue.emptyText");
    act(() => result.current.setDraft("改后第一行\n改后第二行"));
    const imeEnter = keyEvent({ key: "Enter", nativeEvent: { isComposing: true } });
    act(() => result.current.onKeyDown(imeEnter));
    expect(imeEnter.preventDefault).not.toHaveBeenCalled();
    expect(result.current.view.editing?.draft).toBe("改后第一行\n改后第二行");
    await act(async () => await result.current.commitEdit());
    expect(input.requeue).toHaveBeenCalledWith({
      steering: ["改后第一行\n改后第二行"],
      followUp: [],
    });
  });

  it("QB-6: unchanged drafts close editing without a clear_queue round trip", async () => {
    setQueue(["未改动"], []);
    const input = props({
      clearQueue: vi.fn(async () => ({ steering: ["未改动"], followUp: [] })),
    });
    const { result } = renderHook(() => useQueueBarController(input), { wrapper: intlWrapper });
    await act(async () => await result.current.view.items[0]?.edit.run());
    await act(async () => await result.current.commitEdit());
    expect(result.current.view.editing).toBeNull();
    expect(input.clearQueue).not.toHaveBeenCalled();
  });
});
