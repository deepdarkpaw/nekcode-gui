// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSubagentConversation, type SubagentConversation } from "./useSubagentConversation.js";
import { NEK_STATUS_TRANSCRIPT_REFRESH_MS } from "./types.js";

const running: SubagentConversation = { rows: [], totalCount: 0, status: "running" };
const completed: SubagentConversation = { ...running, status: "completed" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("S2: refreshes running preview single-flight, then stops at completion", async () => {
  let finish!: (value: SubagentConversation) => void;
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(completed);
  const { result } = renderHook(() => useSubagentConversation(load, true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => finish(running));
  expect(result.current.data).toEqual(running);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  });
  expect(result.current.data).toEqual(completed);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  });
  expect(load).toHaveBeenCalledTimes(2);
});

it("S2: late old-child results cannot overwrite the selected child; hidden panes do not poll", async () => {
  let finish!: (value: SubagentConversation) => void;
  const old = vi.fn(
    () =>
      new Promise<SubagentConversation>((resolve) => {
        finish = resolve;
      }),
  );
  const next = vi.fn(async () => completed);
  const { result, rerender, unmount } = renderHook(
    ({ load, active }) => useSubagentConversation(load, active),
    { initialProps: { load: old, active: true } },
  );
  rerender({ load: next, active: true });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => finish(running));
  expect(result.current.data).toEqual(completed);
  rerender({ load: next, active: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000);
  });
  expect(next).toHaveBeenCalledTimes(1);
  unmount();
});

it("S2: refresh failures preserve rendered content, show an error and allow explicit retry", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(running)
    .mockRejectedValueOnce(new Error("read failed"))
    .mockResolvedValueOnce(completed);
  const { result } = renderHook(() => useSubagentConversation(load, true));
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  });
  expect(result.current.data).toEqual(running);
  expect(result.current.error).toBe("read failed");
  await act(async () => result.current.retry());
  expect(result.current.data).toEqual(completed);
  expect(result.current.error).toBeUndefined();
});
