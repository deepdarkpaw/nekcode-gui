// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNekStatusStore } from "./store.js";
import { intlWrapper } from "./controllerTestUtils.js";
import { useRetryBannerController } from "./useRetryBannerController.js";
import { useCompactionController } from "./useCompactionController.js";
import { useUsageIndicatorController } from "./useUsageIndicatorController.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  useNekStatusStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function stats() {
  return {
    sessionFile: undefined,
    sessionId: "s",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 84_000, output: 10_000, cacheRead: 2_000, cacheWrite: 1_000, total: 97_000 },
    cost: 1.23,
    contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
  };
}

describe("retry, compaction, and usage controllers", () => {
  it("RT-5/RT-7/RT-8: renders phase messages, cancels through the right callback, and dismisses failures", async () => {
    useNekStatusStore.getState().consumeEvent(
      "s",
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 5000,
        errorMessage: "bad",
      },
      0,
    );
    const abortRetry = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useRetryBannerController({ sessionKey: "s", abortRetry, abort }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view.message).toEqual({
      id: "nek.status.retry.waiting",
      values: { attempt: 1, max: 2, seconds: 5 },
    });
    await act(async () => await result.current.actions.cancelRetry.run());
    expect(abortRetry).toHaveBeenCalledTimes(1);
    expect(result.current.view.phase).toBe("cancelling");
    act(() => {
      useNekStatusStore
        .getState()
        .consumeEvent(
          "s",
          { type: "auto_retry_end", success: false, attempt: 2, finalError: "final" },
          1,
        );
    });
    expect(result.current.actions.dismiss.visible).toBe(true);
    await act(async () => await result.current.actions.dismiss.run());
    expect(useNekStatusStore.getState().sessions.s?.retry).toBeNull();
  });

  it("RT-2: updates the countdown and transitions to retrying at zero", () => {
    useNekStatusStore.getState().consumeEvent(
      "s",
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 1000,
        errorMessage: "bad",
      },
      0,
    );
    const { result } = renderHook(
      () => useRetryBannerController({ sessionKey: "s", abortRetry: vi.fn(), abort: vi.fn() }),
      { wrapper: intlWrapper },
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.view.phase).toBe("retrying");
    expect(result.current.view.message?.id).toBe("nek.status.retry.retrying");
  });

  it("CP-1/CP-2/CP-3: exposes reason, live elapsed, cancel, and failed dismiss", async () => {
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "compaction_start", reason: "overflow" }, 0);
    const abortCompaction = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useCompactionController({ sessionKey: "s", abortCompaction }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view.message?.id).toBe("nek.status.compaction.overflow");
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.view.elapsedMs).toBe(2000);
    await act(async () => await result.current.actions.cancelCompaction.run());
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    act(() => {
      useNekStatusStore.getState().consumeEvent(
        "s",
        {
          type: "compaction_end",
          reason: "overflow",
          aborted: false,
          willRetry: false,
          errorMessage: "failed",
        },
        2,
      );
    });
    expect(result.current.view.error).toBe("failed");
    await act(async () => await result.current.actions.dismiss.run());
    expect(useNekStatusStore.getState().sessions.s?.compaction).toBeNull();
  });

  it("CP-3/CI-6: hides compaction and its cancel action while the model resumes thinking", () => {
    const store = useNekStatusStore.getState();
    store.consumeEvent("s", { type: "agent_start" }, 0);
    store.consumeEvent("s", { type: "compaction_start", reason: "overflow" }, 1);
    const { result } = renderHook(
      () => useCompactionController({ sessionKey: "s", abortCompaction: vi.fn() }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view.visible).toBe(true);
    act(() => {
      store.consumeEvent(
        "s",
        { type: "compaction_end", reason: "overflow", aborted: false, willRetry: true },
        2,
      );
      store.consumeEvent("s", { type: "agent_start" }, 3);
    });
    expect(result.current.view.visible).toBe(false);
    expect(result.current.actions.cancelCompaction.visible).toBe(false);
    expect(useNekStatusStore.getState().sessions.s?.running).toBe(true);
    act(() => {
      store.consumeEvent("s", { type: "compaction_start", reason: "overflow" }, 4);
    });
    expect(result.current.view.visible).toBe(true);
  });

  it("US-1/US-2/US-3/US-4/US-5: formats empty, ready, stale, and threshold views", () => {
    const onCompact = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useUsageIndicatorController({ sessionKey: "s", onCompact }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view).toEqual({ state: "empty" });
    act(() => useNekStatusStore.getState().setStats("s", stats(), 1));
    expect(result.current.view.state).toBe("ready");
    if (result.current.view.state !== "ready") throw new Error("expected ready");
    expect(result.current.view.tokens.input).toBe("84k");
    expect(result.current.view.context).toMatchObject({
      percent: 42,
      tokens: "84k",
      window: "200k",
    });
    expect(result.current.view.level).toBe("neutral");
    act(() => {
      useNekStatusStore
        .getState()
        .setStats(
          "s",
          { ...stats(), contextUsage: { tokens: 180_000, contextWindow: 200_000, percent: 90 } },
          2,
        );
    });
    expect(result.current.view.state === "ready" && result.current.view.level).toBe("danger");
  });

  it("US-6: disables compact during compaction and calls it otherwise", async () => {
    useNekStatusStore.getState().setStats("s", stats(), 0);
    const onCompact = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () => useUsageIndicatorController({ sessionKey: "s", onCompact }),
      { wrapper: intlWrapper },
    );
    await act(async () => await result.current.actions.compact.run());
    expect(onCompact).toHaveBeenCalledTimes(1);
    act(() => {
      useNekStatusStore
        .getState()
        .consumeEvent("s", { type: "compaction_start", reason: "manual" }, 1);
    });
    expect(result.current.actions.compact.enabled).toBe(false);
    expect(result.current.actions.compact.disabledReason?.id).toBe("nek.status.usage.compacting");
  });
});
