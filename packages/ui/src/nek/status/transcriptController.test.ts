// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNekStatusStore } from "./store.js";
import { intlWrapper } from "./controllerTestUtils.js";
import {
  resolveTranscriptKey,
  useSubagentTranscriptController,
} from "./useSubagentTranscriptController.js";

beforeEach(() => {
  vi.useFakeTimers();
  useNekStatusStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("subagent transcript controller", () => {
  it("TR-1/TR-4: loads immediately and retains only the last 500 messages", async () => {
    const fetchTranscript = vi
      .fn()
      .mockResolvedValue({ messages: Array.from({ length: 505 }, (_, i) => i) });
    const { result } = renderHook(
      () =>
        useSubagentTranscriptController({
          sessionKey: "s",
          id: "a",
          fetchTranscript,
          onBack: vi.fn(),
        }),
      { wrapper: intlWrapper },
    );
    await act(async () => await Promise.resolve());
    expect(fetchTranscript).toHaveBeenCalledWith("a");
    expect(result.current.view.state.status).toBe("loaded");
    if (result.current.view.state.status !== "loaded") throw new Error("expected loaded");
    expect(result.current.view.state.messages).toHaveLength(500);
    expect(result.current.view.state.truncatedCount).toBe(5);
  });

  it("TR-2/TR-3: refreshes running records every three seconds and preserves old content on failure", async () => {
    useNekStatusStore.getState().consumeEvent(
      "s",
      {
        type: "nek.subagent",
        payload: {
          id: "a",
          description: "a",
          type: "worker",
          background: false,
          status: "running",
          startedAt: 0,
        },
      },
      0,
    );
    const fetchTranscript = vi
      .fn()
      .mockResolvedValueOnce({ messages: ["first"] })
      .mockRejectedValueOnce(new Error("refresh failed"));
    const { result } = renderHook(
      () =>
        useSubagentTranscriptController({
          sessionKey: "s",
          id: "a",
          fetchTranscript,
          onBack: vi.fn(),
        }),
      { wrapper: intlWrapper },
    );
    await act(async () => await Promise.resolve());
    expect(result.current.view.state.status).toBe("loaded");
    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(result.current.view.refreshing).toBe(false);
    expect(result.current.view.refreshError).toBe("refresh failed");
    if (result.current.view.state.status !== "loaded") throw new Error("expected loaded");
    expect(result.current.view.state.messages).toEqual(["first"]);
  });

  it("TR-5: resolves Esc and Alt+Left, but never during IME composition", () => {
    expect(resolveTranscriptKey({ key: "Escape" })).toBe("back");
    expect(resolveTranscriptKey({ key: "ArrowLeft", altKey: true })).toBe("back");
    expect(resolveTranscriptKey({ key: "Escape", isComposing: true })).toBeNull();
    expect(resolveTranscriptKey({ key: "ArrowLeft", altKey: true, keyCode: 229 })).toBeNull();
  });

  it("TR-6: ignores a late response after unmount", async () => {
    let resolve!: (value: { messages: unknown[] }) => void;
    const fetchTranscript = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onBack = vi.fn();
    const { result, unmount } = renderHook(
      () => useSubagentTranscriptController({ sessionKey: "s", id: "a", fetchTranscript, onBack }),
      { wrapper: intlWrapper },
    );
    unmount();
    await act(async () => resolve({ messages: ["late"] }));
    expect(result.current.view.state.status).toBe("loading");
  });
});
