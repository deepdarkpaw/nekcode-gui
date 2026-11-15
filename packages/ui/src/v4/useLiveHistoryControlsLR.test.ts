// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConversationHistoryControls } from "./useConversationHistoryControls.js";
import { livePage, liveRow, liveStore } from "./liveHistoryRenderer.testFixtures.js";
import { HISTORY_BOUNDARY_REFRESH_REQUIRED } from "./conversationHistoryWindow.js";
import type { ConversationProjectionStore } from "./conversationProjectionStore.js";
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), lifecycle: { info: vi.fn(), warn: vi.fn() } },
}));
vi.mock("./useConversationHistoryDirectory.js", () => ({
  useConversationHistoryDirectory: () => ({
    items: [],
    totalTurns: 20,
    hasMore: false,
    loading: false,
    error: null,
    query: null,
    loadMore() {},
    reload() {},
  }),
}));
const stores: ConversationProjectionStore[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.restoreAllMocks();
});

it("LCB4: the boundary error Retry action refreshes latest instead of repeating a missing cursor read", async () => {
  const h = await liveStore();
  stores.push(h.store);
  h.send(
    Array.from({ length: 130 }, (_, index) => ({ op: "row.appended", row: liveRow(index + 20) })),
  );
  expect(h.store.getState().historyError).toBe(HISTORY_BOUNDARY_REFRESH_REQUIRED);
  h.transport.historyPage.mockResolvedValueOnce(h.atCurrent(livePage(130, 150)));
  const { result } = renderHook(() => useConversationHistoryControls(h.store));
  await act(async () => {
    await result.current!.retry();
  });
  expect(h.transport.historyPage).toHaveBeenCalledExactlyOnceWith({
    sessionId: "parent",
    turnLimit: 20,
  });
  expect(h.store.getState().historyError).toBeNull();
  expect(h.store.getState().snapshot!.rows.window.at(-1)!.turnId).toBe("turn:149");
  expect(h.transport.sendCommand).not.toHaveBeenCalled();
});

it("LR4/LR5/LR6: viewport and history-only resync callbacks are stable, scope-bound and never run during render", async () => {
  const first = await liveStore();
  const second = await liveStore();
  stores.push(first.store, second.store);
  const anchor = vi.spyOn(first.store, "setViewportAnchor");
  const resync = vi.spyOn(first.store, "resyncHistory").mockImplementation(() => {});
  const nextAnchor = vi.spyOn(second.store, "setViewportAnchor");
  const { result, rerender } = renderHook(({ store }) => useConversationHistoryControls(store), {
    initialProps: { store: first.store },
  });
  expect(anchor).not.toHaveBeenCalled();
  expect(resync).not.toHaveBeenCalled();
  const setViewport = result.current!.setViewportAnchor;
  const retryHistory = result.current!.resyncHistory;
  first.append(20);
  rerender({ store: first.store });
  expect(result.current!.setViewportAnchor).toBe(setViewport);
  expect(result.current!.resyncHistory).toBe(retryHistory);
  setViewport!({ turnId: "turn:5", followingLatest: false });
  retryHistory!();
  expect(anchor).toHaveBeenCalledExactlyOnceWith({ turnId: "turn:5", followingLatest: false });
  expect(resync).toHaveBeenCalledTimes(1);
  expect(first.transport.historyPage).not.toHaveBeenCalled();
  expect(first.transport.sendCommand).not.toHaveBeenCalled();
  rerender({ store: second.store });
  expect(result.current!.setViewportAnchor).not.toBe(setViewport);
  expect(result.current!.resyncHistory).not.toBe(retryHistory);
  expect(nextAnchor).not.toHaveBeenCalled();
  result.current!.setViewportAnchor!({ turnId: "turn:10", followingLatest: true });
  expect(nextAnchor).toHaveBeenCalledTimes(1);
  expect(anchor).toHaveBeenCalledTimes(1);
});
