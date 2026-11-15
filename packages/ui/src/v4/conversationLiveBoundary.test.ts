import { afterEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationHistoryPageResult } from "@zcode/shared/zcode-protocol-v4";
import { HISTORY_BOUNDARY_REFRESH_REQUIRED } from "./conversationHistoryWindow.js";
import type { ConversationProjectionStore } from "./conversationProjectionStore.js";
import { deferredValue, livePage, liveRow, liveStore } from "./liveHistoryRenderer.testFixtures.js";

vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), lifecycle: { info: vi.fn(), warn: vi.fn() } },
}));
const stores: ConversationProjectionStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
async function setup(initial = livePage(30, 50)) {
  const h = await liveStore(initial);
  stores.push(h.store);
  return h;
}

describe("LCB live history navigation", () => {
  it("LCB1: entering a not-yet-indexed live tail preserves the proven navigation boundary", async () => {
    const h = await setup();
    h.send([{ op: "row.appended", row: liveRow(50) }]);
    h.store.setViewportAnchor({ turnId: "turn:50", followingLatest: false });
    const current = h.store.getState();
    expect(current.historyError).toBeNull();
    expect(current.snapshot!.history).toMatchObject({
      totalTurns: 50,
      olderCursor: "before:30",
      hasOlder: true,
      hasNewer: false,
    });
    expect(current.snapshot!.history!.turns.some((turn) => turn.position === 50)).toBe(false);
    expect(current.snapshot!.rows.window.at(-1)).toMatchObject({ text: "answer 50" });
    expect(h.transport.historyPage).not.toHaveBeenCalled();
    h.send([{ op: "state.updated", patch: { history: livePage(31, 51).history } }]);
    expect(h.store.getState().historyError).toBeNull();
    expect(h.store.getState().snapshot!.history!.turns.at(-1)!.position).toBe(50);
  });

  it("LCB1/LCB3: an unindexed tail across an unloaded source gap cannot invent a boundary", async () => {
    const h = await setup(livePage(10, 30, 100));
    h.send([{ op: "row.appended", row: liveRow(100) }]);
    h.store.setViewportAnchor({ turnId: "turn:100", followingLatest: false });
    expect(h.store.getState().historyError).toBe(HISTORY_BOUNDARY_REFRESH_REQUIRED);
    expect(h.transport.historyPage).not.toHaveBeenCalled();
  });

  it("LCB4: explicit latest supersedes an in-flight older read and retires its late response", async () => {
    const h = await setup();
    const pendingOlder = deferredValue<V4ConversationHistoryPageResult>();
    h.transport.historyPage
      .mockImplementationOnce(() => pendingOlder.promise)
      .mockResolvedValueOnce(livePage(40, 60));
    const older = h.store.loadOlder();
    const latest = await h.store.loadLatest();
    expect(latest).not.toBeNull();
    expect(h.transport.historyPage).toHaveBeenCalledTimes(2);
    expect(h.store.getState().snapshot!.rows.window.at(-1)!.turnId).toBe("turn:59");
    pendingOlder.resolve(livePage(10, 30, 50));
    await older;
    expect(h.store.getState().snapshot!.rows.window[0]!.turnId).toBe("turn:40");
    expect(h.store.getState().snapshot!.rows.window.at(-1)!.turnId).toBe("turn:59");
    expect(h.store.getState().historyError).toBeNull();
    expect(h.store.getState().historyRequest).toBeNull();
  });

  it("LCB4/LCB5: latest repairs a real missing boundary and subsequent live tasks remain visible", async () => {
    const h = await setup(livePage(0, 20));
    h.send(
      Array.from({ length: 130 }, (_, index) => ({
        op: "row.appended" as const,
        row: liveRow(index + 20),
      })),
    );
    expect(h.store.getState().historyError).toBe(HISTORY_BOUNDARY_REFRESH_REQUIRED);
    h.transport.historyPage.mockResolvedValueOnce(h.atCurrent(livePage(130, 150)));
    expect(await h.store.loadLatest()).not.toBeNull();
    expect(h.store.getState().historyError).toBeNull();
    h.store.setViewportAnchor({ turnId: "turn:149", followingLatest: true });
    h.append(150);
    expect(h.store.getState().snapshot!.rows.window.at(-1)!.turnId).toBe("turn:150");
    expect(h.store.getState().snapshot!.history!.hasNewer).toBe(false);
    expect(h.store.getState().historyError).toBeNull();
    expect(h.transport.historyPage).toHaveBeenCalledExactlyOnceWith({
      sessionId: "parent",
      turnLimit: 20,
    });
  });
});
