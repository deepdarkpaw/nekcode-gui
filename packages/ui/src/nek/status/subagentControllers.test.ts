// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NekSubagentRecord } from "@zcode/shared/nek-protocol";
import { useNekStatusStore } from "./store.js";
import { useSubagentCardController } from "./useSubagentCardController.js";
import { useRunningSubagentsBarController } from "./useRunningSubagentsBarController.js";
import { intlWrapper } from "./controllerTestUtils.js";

function record(id: string, status: NekSubagentRecord["status"] = "running"): NekSubagentRecord {
  return {
    id,
    description: `description-${id}`,
    type: "worker",
    background: true,
    status,
    model: "model",
    usage: { input: 1000, output: 2000 },
    startedAt: 0,
    ...(status === "completed" ? { endedAt: 2000, finalText: "done" } : {}),
    ...(status === "errored" ? { endedAt: 2000, error: "failed" } : {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  useNekStatusStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("subagent controllers", () => {
  it("SA-1: exposes all terminal states, body, status tone, and elapsed refresh", () => {
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a") }, 0);
    const { result, rerender } = renderHook(
      () =>
        useSubagentCardController({
          sessionKey: "s",
          id: "a",
          onStop: vi.fn(),
          onOpenTranscript: vi.fn(),
        }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view.statusId).toBe("nek.status.subagent.running");
    expect(result.current.view.metaParts).toEqual(["model", "worker", "↑1k ↓2k", "0s"]);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.view.elapsedMs).toBe(1000);
    act(() => {
      useNekStatusStore
        .getState()
        .consumeEvent("s", { type: "nek.subagent", payload: record("a", "completed") }, 2000);
    });
    rerender();
    expect(result.current.view.statusId).toBe("nek.status.subagent.completed");
    expect(result.current.view.body).toEqual({ text: "done" });
  });

  it("SA-1: renders errored and aborted body semantics", () => {
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("error", "errored") }, 0);
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("aborted", "aborted") }, 0);
    const error = renderHook(
      () =>
        useSubagentCardController({
          sessionKey: "s",
          id: "error",
          onStop: vi.fn(),
          onOpenTranscript: vi.fn(),
        }),
      { wrapper: intlWrapper },
    );
    const aborted = renderHook(
      () =>
        useSubagentCardController({
          sessionKey: "s",
          id: "aborted",
          onStop: vi.fn(),
          onOpenTranscript: vi.fn(),
        }),
      { wrapper: intlWrapper },
    );
    expect(error.result.current.view.tone).toBe("danger");
    expect(error.result.current.view.body).toEqual({ text: "failed" });
    expect(aborted.result.current.view.tone).toBe("muted");
    expect(aborted.result.current.view.body).toEqual({
      message: { id: "nek.status.subagent.abortedBody" },
    });
  });

  it("SA-2: stops once, marks stop requested, and clears it after timeout", async () => {
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a") }, 0);
    const onStop = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(
      () =>
        useSubagentCardController({ sessionKey: "s", id: "a", onStop, onOpenTranscript: vi.fn() }),
      { wrapper: intlWrapper },
    );
    await act(async () => {
      await Promise.all([result.current.actions.stop.run(), result.current.actions.stop.run()]);
    });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(useNekStatusStore.getState().sessions.s?.subagents.byId.a?.stopRequested).toBe(true);
    act(() => vi.advanceTimersByTime(15_000));
    expect(
      useNekStatusStore.getState().sessions.s?.subagents.byId.a?.stopRequested,
    ).toBeUndefined();
    expect(result.current.actions.stop.error).toContain("stop request");
  });

  it("RB-1/RB-2: sorts, limits to three, and reports overflow", () => {
    for (const [index, id] of ["a", "b", "c", "d"].entries()) {
      useNekStatusStore
        .getState()
        .consumeEvent(
          "s",
          { type: "nek.subagent", payload: { ...record(id), startedAt: 4 - index } },
          0,
        );
    }
    const { result } = renderHook(
      () =>
        useRunningSubagentsBarController({
          sessionKey: "s",
          onStop: vi.fn(),
          onFocusSubagent: vi.fn(),
        }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view.visible).toBe(true);
    expect(result.current.view.items.map((item) => item.id)).toEqual(["d", "c", "b"]);
    expect(result.current.view.overflow).toBe(1);
    expect(result.current.actions.toggleExpand.visible).toBe(true);
  });

  it("RB-3/RB-4/RB-5: stops an item, stops all concurrently, and focuses an item", async () => {
    for (const id of ["a", "b"]) {
      useNekStatusStore
        .getState()
        .consumeEvent("s", { type: "nek.subagent", payload: record(id) }, 0);
    }
    const onStop = vi.fn().mockResolvedValue(undefined);
    const onFocus = vi.fn();
    const { result } = renderHook(
      () => useRunningSubagentsBarController({ sessionKey: "s", onStop, onFocusSubagent: onFocus }),
      { wrapper: intlWrapper },
    );
    result.current.view.items[0]?.focus();
    expect(onFocus).toHaveBeenCalledWith("a");
    await act(async () => await result.current.view.items[0]?.stop.run());
    expect(onStop).toHaveBeenCalledWith("a");
    await act(async () => await result.current.actions.stopAll.run());
    expect(onStop).toHaveBeenCalledTimes(3);
  });

  it("RB-6: emits a finished event once for a running-to-terminal transition", () => {
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a") }, 0);
    const first = useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a", "completed") }, 1);
    const second = useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a", "completed") }, 2);
    expect(first.subagentFinished).toHaveLength(1);
    expect(second.subagentFinished).toBeUndefined();
  });
});
