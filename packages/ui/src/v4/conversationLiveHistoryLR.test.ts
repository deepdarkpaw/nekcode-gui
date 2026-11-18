import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coalesceConversationDeltas,
  PROTOCOL_V4_LIMITS,
  type ConversationDelta,
  type V4ConversationHistoryPageResult,
} from "@zcode/shared/zcode-protocol-v4";
import { applyConversationLiveDeltas } from "./conversationLiveDeltas.js";
import { historyAppendJsonBytes } from "./conversationHistoryBoundary.js";
import {
  ConversationHistoryWindow,
  HISTORY_WINDOW_LIMITS,
  HISTORY_BOUNDARY_REFRESH_REQUIRED,
} from "./conversationHistoryWindow.js";
import {
  deferredValue,
  livePage,
  liveRow,
  liveSnapshot,
  liveStore,
} from "./liveHistoryRenderer.testFixtures.js";
import type { ConversationProjectionStore } from "./conversationProjectionStore.js";
vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), lifecycle: { info: vi.fn(), warn: vi.fn() } },
}));
const stores: ConversationProjectionStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  vi.restoreAllMocks();
});
async function setup(initial = livePage(0, 20)) {
  const h = await liveStore(initial);
  stores.push(h.store);
  return h;
}

describe("LR bounded live history renderer", () => {
  it("LR1: exact removals preserve other older pages, canonical appends sort and dedupe row/entity identities", async () => {
    const h = await setup(livePage(10, 30, 40));
    h.transport.historyPage.mockResolvedValueOnce(livePage(0, 10, 40));
    await h.store.loadOlder();
    const old = h.store.getState().snapshot!.rows.window.find((row) => row.rowId === 1);
    const canonical = { ...liveRow(25), rowId: 207, entityId: "canonical" };
    h.send([
      { op: "rows.removed", rowIds: [201] },
      { op: "row.appended", row: canonical },
      { op: "row.appended", row: canonical },
      { op: "row.appended", row: { ...canonical, rowId: 208 } },
    ]);
    const rows = h.store.getState().snapshot!.rows.window;
    expect(rows.find((row) => row.rowId === 1)).toBe(old);
    expect(rows.some((row) => row.rowId === 201)).toBe(false);
    expect(rows.some((row) => row.rowId === 291)).toBe(true);
    expect(rows.filter((row) => row.entityId === "canonical").map((row) => row.rowId)).toEqual([
      208,
    ]);
    expect(rows.map((row) => row.rowId)).toEqual(
      rows.map((row) => row.rowId).toSorted((a, b) => a - b),
    );
    h.send([{ op: "row.removed", fromRowId: 208 }]);
    expect(h.store.getState().snapshot!.rows.window.every((row) => row.rowId < 208)).toBe(true);
  });

  it("LR1: canonical structural deltas coalesce equivalently and never mutate a published snapshot", () => {
    const initial = liveSnapshot(livePage(0, 3));
    const original = JSON.stringify(initial);
    const changes: ConversationDelta[] = [
      { op: "row.delta", rowId: 11, path: "text", append: "pending" },
      { op: "rows.removed", rowIds: [11] },
      { op: "row.appended", row: { ...liveRow(1), rowId: 12 } },
      { op: "row.appended", row: { ...liveRow(1), rowId: 12 } },
      { op: "row.delta", rowId: 12, path: "text", append: " final" },
    ];
    const result = applyConversationLiveDeltas(initial, changes);
    expect(applyConversationLiveDeltas(initial, coalesceConversationDeltas(changes))).toEqual(
      result,
    );
    expect(result.rows.window.map((row) => row.rowId)).toEqual([1, 12, 21]);
    expect(JSON.stringify(initial)).toBe(original);
  });

  it("LR2: ordered boundary-only history changes revision/count but never replaces rows", async () => {
    const h = await setup(livePage(0, 20));
    const before = h.store.getState().snapshot!;
    const owner = h.store.getHistoryOwnerKey();
    const summary = livePage(10, 30).history;
    h.send([{ op: "state.updated", patch: { history: summary } }]);
    const after = h.store.getState().snapshot!;
    expect(after.history!.totalTurns).toBe(30);
    expect(after.history!.branchRevision).toBe("source:30");
    expect(after.history!.turns).toHaveLength(20);
    expect(after.history!.turns.some((turn) => turn.position === 20)).toBe(false);
    expect(after.rows.window).toBe(before.rows.window);
    expect(after.control).toBe(before.control);
    expect(after.queue).toBe(before.queue);
    expect(h.store.getHistoryOwnerKey()).toBe(owner);
    expect(h.transport.historyPage).not.toHaveBeenCalled();
  });

  it("LR2/LR6: a late guarded page cannot regress newer accepted host boundary metadata or newer text", async () => {
    const initial = livePage(30, 50, 50);
    initial.history.observationCursor = "observation:50";
    const h = await setup(initial);
    const pending = deferredValue<V4ConversationHistoryPageResult>();
    h.transport.historyPage.mockImplementationOnce(() => pending.promise);
    const request = h.store.loadOlder();
    h.send([
      { op: "row.delta", rowId: 301, path: "text", append: " streamed" },
      {
        op: "state.updated",
        patch: { history: { ...livePage(31, 51).history, observationCursor: "observation:51" } },
      },
    ]);
    const older = livePage(10, 30, 50);
    older.history.observationCursor = "observation:50";
    pending.resolve(older);
    await request;
    const after = h.store.getState().snapshot!;
    expect(after.history!.totalTurns).toBe(51);
    expect(after.history!.branchRevision).toBe("source:51");
    expect(after.history!.observationCursor).toBe("observation:51");
    expect(after.rows.window.find((row) => row.rowId === 301)).toMatchObject({
      text: "answer 30 streamed",
    });
    expect(after.rows.window.some((row) => row.rowId === 101)).toBe(true);
    expect(h.store.getState().historyError).toBeNull();
  });

  it("LR3: 150 changing-revision live rounds stay bounded and directional repair uses one real around read", async () => {
    const h = await setup();
    for (let position = 20; position < 150; position++) {
      h.append(position);
      expect(
        new Set(h.store.getState().snapshot!.rows.window.map((row) => row.turnId)).size,
      ).toBeLessThanOrEqual(120);
      expect(h.store.getState().historyError).toBeNull();
    }
    const current = h.store.getState().snapshot!;
    expect(current.history!.totalTurns).toBe(150);
    expect(current.rows.window[0]!.turnId).toBe("turn:30");
    expect(current.history!.olderCursor).toBeUndefined();
    expect(h.transport.historyPage).not.toHaveBeenCalled();
    h.transport.historyPage.mockResolvedValueOnce(h.atCurrent(livePage(20, 40, 150)));
    await h.store.loadOlder();
    expect(h.transport.historyPage).toHaveBeenCalledExactlyOnceWith({
      sessionId: "parent",
      turnLimit: 20,
      aroundEntryId: "entry:30",
    });
    expect(h.store.getState().snapshot!.rows.window.some((row) => row.turnId === "turn:20")).toBe(
      true,
    );
    expect(h.store.getState().historyError).toBeNull();
  });

  it("LR4: 150 rounds while reading older preserve the pinned row/intent, expose unread newer source and recover it", async () => {
    const h = await setup(livePage(0, 20));
    h.store.setViewportAnchor({ turnId: "turn:5", followingLatest: false });
    const pinned = h.store.getState().snapshot!.rows.window.find((row) => row.turnId === "turn:5");
    for (let position = 20; position < 150; position++) h.append(position);
    const current = h.store.getState().snapshot!;
    expect(current.rows.window.find((row) => row.turnId === "turn:5")).toBe(pinned);
    expect(current.rows.window.at(-1)!.turnId).toBe("turn:119");
    expect(current.history!.hasNewer).toBe(true);
    expect(current.history!.newerCursor).toBeUndefined();
    expect(h.transport.historyPage).not.toHaveBeenCalled();
    h.store.setViewportAnchor({ turnId: "turn:119", followingLatest: false });
    h.transport.historyPage
      .mockResolvedValueOnce(h.atCurrent(livePage(109, 129, 150)))
      .mockResolvedValueOnce(h.atCurrent(livePage(129, 149, 150)));
    await h.store.loadNewer();
    // The repair read adds only turns 120-128; the same action continues with the issued cursor.
    expect(h.transport.historyPage.mock.calls.map(([params]) => params)).toEqual([
      { sessionId: "parent", turnLimit: 20, aroundEntryId: "entry:119" },
      {
        sessionId: "parent",
        turnLimit: 20,
        afterCursor: "after:129",
        observationCursor: undefined,
      },
    ]);
    expect(h.store.getState().snapshot!.rows.window.some((row) => row.turnId === "turn:128")).toBe(
      true,
    );
    expect(h.store.getState().historyError).toBeNull();
    h.store.setViewportAnchor({ turnId: "turn:119", followingLatest: true });
    for (let position = 150; position < 280; position++) h.append(position);
    expect(h.store.getState().snapshot!.rows.window[0]!.turnId).toBe("turn:160");
    expect(h.store.getState().snapshot!.rows.window.at(-1)!.turnId).toBe("turn:279");
    expect(h.store.getState().historyError).toBeNull();
    expect(h.transport.historyPage).toHaveBeenCalledTimes(2);
  });

  it("LR3/LR4: an older reading segment does not skip unloaded source turns to a separate live tail", async () => {
    const h = await setup(livePage(10, 30, 100));
    h.append(100);
    expect(h.store.getState().snapshot!.history!.hasNewer).toBe(false);
    const before = h.store.getState().snapshot!;
    const notify = vi.fn();
    const detach = h.store.subscribe(notify);
    h.store.setViewportAnchor({ turnId: "turn:15", followingLatest: false });
    h.store.setViewportAnchor({ turnId: "turn:15", followingLatest: false });
    expect(notify).toHaveBeenCalledTimes(1);
    detach();
    expect(h.store.getState().snapshot!.rows.window).toBe(before.rows.window);
    expect(h.store.getState().snapshot!.seq).toBe(before.seq);
    expect(h.store.getState().snapshot!.history!.hasNewer).toBe(true);
    h.transport.historyPage.mockResolvedValueOnce(h.atCurrent(livePage(30, 50, 101)));
    await h.store.loadNewer();
    expect(h.transport.historyPage).toHaveBeenCalledExactlyOnceWith({
      sessionId: "parent",
      turnLimit: 20,
      afterCursor: "after:30",
    });
    expect(h.store.getState().snapshot!.rows.window.some((row) => row.turnId === "turn:30")).toBe(
      true,
    );
  });

  it("LR3: six admitted body pages remain bounded and escaped Unicode delta bytes use actual JSON size", async () => {
    const h = await setup(livePage(180, 200, 200));
    for (let end = 180; end > 40; end -= 20) {
      h.transport.historyPage.mockResolvedValueOnce(livePage(end - 20, end, 200));
      await h.store.loadOlder();
    }
    expect(h.store.countProjectionRows()).toBeLessThanOrEqual(120);
    const window = new ConversationHistoryWindow();
    const initial = window.reset(liveSnapshot(livePage(0, 1)));
    const append = '\\"\n界'.repeat(5_700_000); // 9 JSON bytes each: just above the 48 MiB budget
    const delta: ConversationDelta = { op: "row.delta", rowId: 1, path: "text", append };
    const grown = applyConversationLiveDeltas(initial, [delta]);
    window.accountDeltas(initial, grown, [delta]);
    const bounded = window.bound(grown);
    expect(new TextEncoder().encode(JSON.stringify(bounded.rows.window)).byteLength).toBeLessThan(
      HISTORY_WINDOW_LIMITS.bytes,
    );
    // The over-budget turn is dropped whole (explicit unproven cut), never folded.
    expect(bounded.rows.window.some((row) => row.turnId === "turn:0")).toBe(false);
    expect(bounded.history!.hasOlder).toBe(true);
  });

  it("LR3: escaped text and split surrogate deltas match exact actual JSON byte growth", () => {
    const encode = (value: string) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    for (const previous of ["", "plain", "界", "\ud83d", "😀", '\\"']) {
      for (const append of ["", "text", "\n\t\u0001", "\ude00", "界😀", '\\"']) {
        expect(historyAppendJsonBytes(append, previous.slice(-1))).toBe(
          encode(previous + append) - encode(previous),
        );
      }
    }
  });

  it("LR5: raw incomplete previews and tool extras remain facts; explicit resync failure keeps rows and never submits a command", async () => {
    const h = await setup();
    const preview = {
      epoch: "source",
      eventId: 9,
      eventType: "message_update",
      preview: '{"type":"message_update","delta":"partial',
      receivedBytes: 2_000_000,
      incomplete: true as const,
    };
    const tool = {
      rowId: 201,
      entityId: "tool:call",
      turnId: "turn:20",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "toolCall" as const,
      toolCallId: "call",
      toolName: "read",
      status: "success" as const,
      inputText: "",
      liveResult: { structuredContent: { count: 2 }, terminate: true },
    };
    h.send([
      { op: "row.appended", row: tool },
      { op: "state.updated", patch: { liveHistoryPreview: preview } },
    ]);
    const before = h.store.getState().snapshot!;
    expect(before.liveHistoryPreview).toEqual(preview);
    expect(before.rows.window.find((row) => row.rowId === tool.rowId)).toMatchObject({
      liveResult: tool.liveResult,
    });
    expect(
      before.rows.window.some(
        (row) => row.kind === "assistantText" && row.text === preview.preview,
      ),
    ).toBe(false);
    h.transport.resync.mockRejectedValueOnce(new Error("RECOVERY_ACTIVE"));
    await expect(h.store.resyncHistory()).rejects.toThrow("RECOVERY_ACTIVE");
    expect(h.store.getState()).toMatchObject({ status: "live", lastError: null });
    expect(h.store.getState().snapshot).toBe(before);
    expect(h.transport.resync).toHaveBeenCalledTimes(1);
    expect(h.transport.sendCommand).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "FU3: history reload waits for both owned frame and ACK (frame first=%s)",
    async (frameFirst) => {
      const h = await setup();
      h.transport.resync.mockRejectedValueOnce(new Error("RECOVERY_ACTIVE"));
      await expect(h.store.resyncHistory()).rejects.toThrow("RECOVERY_ACTIVE");
      const ack = deferredValue<Awaited<ReturnType<typeof h.transport.resync>>>();
      h.transport.resync.mockReturnValueOnce(ack.promise);
      const retry = h.store.resyncHistory();
      expect(h.store.resyncHistory()).toBe(retry);
      const done = vi.fn();
      void retry.then(done);
      const sendAck = () =>
        ack.resolve({
          ack: { subscriptionId: "subscription", mode: "snapshot", logEpoch: "epoch" },
        });
      const sendFrame = () => h.frame(liveSnapshot(livePage(1, 21)), "recovery");
      if (frameFirst) sendFrame();
      else sendAck();
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      if (frameFirst) sendAck();
      else sendFrame();
      await retry;
      expect(done).toHaveBeenCalledTimes(1);
      expect(h.transport.resync).toHaveBeenCalledTimes(2);
      expect(h.transport.sendCommand).not.toHaveBeenCalled();
    },
  );

  it("FU3: missing recovery frame leaves existing conversation live and the history action retryable", async () => {
    const h = await setup();
    vi.useFakeTimers();
    try {
      const snapshot = h.store.getState().snapshot;
      const result = expect(h.store.resyncHistory()).rejects.toThrow("recoveryFrameTimedOut");
      await vi.advanceTimersByTimeAsync(2 * PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
      await result;
      expect(h.store.getState()).toMatchObject({ status: "live", lastError: null });
      expect(h.store.getState().snapshot).toBe(snapshot);
      const retry = h.store.resyncHistory();
      h.frame(liveSnapshot(livePage(1, 21)), "recovery");
      await retry;
      expect(h.transport.resync).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("FU3: owner change rejects explicit history reload and late ACK cannot fail the new subscription", async () => {
    const h = await setup();
    const ack = deferredValue<Awaited<ReturnType<typeof h.transport.resync>>>();
    h.transport.resync.mockReturnValueOnce(ack.promise);
    const failed = expect(h.store.resyncHistory()).rejects.toThrow("historyNotConnected");
    await h.store.retry();
    await failed;
    ack.reject(new Error("old owner failed"));
    await Promise.resolve();
    expect(h.store.getState()).toMatchObject({ status: "live", lastError: null });
    expect(h.transport.sendCommand).not.toHaveBeenCalled();
  });

  it("FU3: joining an automatic transport recovery does not hide its real connection failure", async () => {
    const h = await setup();
    const ack = deferredValue<Awaited<ReturnType<typeof h.transport.resync>>>();
    h.transport.resync.mockReturnValueOnce(ack.promise);
    h.store.recoverFromStaleAuthority();
    const failed = expect(h.store.resyncHistory()).rejects.toThrow("connection closed");
    ack.reject(new Error("connection closed"));
    await failed;
    expect(h.store.getState()).toMatchObject({ status: "error", lastError: "connection closed" });
    expect(h.transport.resync).toHaveBeenCalledTimes(1);
  });

  it("LR6: exact removals fence delayed pages; late metadata never clears an explicit paging error", async () => {
    const h = await setup();
    const pending = deferredValue<V4ConversationHistoryPageResult>();
    h.transport.historyPage.mockImplementationOnce(() => pending.promise);
    const request = h.store.loadAround("entry:10");
    h.send([{ op: "rows.removed", rowIds: [101] }]);
    pending.resolve(livePage(0, 20));
    await request;
    expect(h.store.getState().historyError).toContain("unloaded live mutation");
    const error = h.store.getState().historyError;
    h.send([{ op: "state.updated", patch: { history: livePage(1, 21).history } }]);
    expect(h.store.getState().historyError).toBe(error);
    expect(h.store.getState().snapshot!.rows.window.some((row) => row.rowId === 101)).toBe(false);
  });

  it("LR6: true branch truncation retires old opaque page boundaries before accepting new metadata capabilities", async () => {
    const initial = livePage(30, 50, 50);
    initial.history.olderCursor = "OLD-BRANCH-BEFORE-30";
    const h = await setup(initial);
    const owner = h.store.getHistoryOwnerKey();
    const boundary = livePage(30, 40, 40).history;
    boundary.olderCursor = "NEW-BRANCH-BEFORE-30";
    h.send([
      { op: "row.removed", fromRowId: 400 },
      { op: "state.updated", patch: { history: boundary } },
    ]);
    expect(h.store.getHistoryOwnerKey()).not.toBe(owner);
    h.transport.historyPage.mockResolvedValueOnce(h.atCurrent(livePage(10, 30, 40)));
    await h.store.loadOlder();
    expect(h.transport.historyPage).toHaveBeenCalledExactlyOnceWith({
      sessionId: "parent",
      turnLimit: 20,
      beforeCursor: "NEW-BRANCH-BEFORE-30",
    });
    expect(h.store.getState().historyError).toBeNull();
  });

  it("LR6: stale subscription/sequence and replaced epoch/closed owners cannot apply late rows or source metadata", async () => {
    const h = await setup();
    const pending = deferredValue<V4ConversationHistoryPageResult>();
    h.transport.historyPage.mockImplementationOnce(() => pending.promise);
    const around = h.store.loadAround("entry:10");
    const stale = h.deltaFrame([{ op: "row.appended", row: liveRow(40) }]);
    h.store.handleFrame({ ...stale, subscriptionId: "old-subscription" });
    h.store.handleFrame({ ...stale, fromSeq: 0, toSeq: 1 });
    const replacement = {
      ...liveSnapshot(livePage(50, 70)),
      logEpoch: "new-epoch",
      seq: 5,
      revision: 5,
    };
    h.frame(replacement, "online");
    pending.resolve(livePage(0, 20));
    await around;
    expect(h.store.getState().snapshot!.logEpoch).toBe("new-epoch");
    expect(h.store.getState().snapshot!.rows.window).toEqual(replacement.rows.window);
    await h.store.close();
    const closed = h.store.getState();
    h.store.setViewportAnchor({ turnId: "turn:50", followingLatest: false });
    h.send([{ op: "row.appended", row: liveRow(100) }]);
    expect(h.store.getState()).toBe(closed);
  });

  it("LR6: a preamble-only edge without a source entry locator reports the exact missing capability", async () => {
    const initial = livePage(0, 1);
    initial.history.turns[0]!.userEntryId = null;
    const h = await setup(initial);
    h.send([{ op: "state.updated", patch: { history: livePage(1, 21).history } }]);
    expect(h.store.getState().snapshot!.history!.turns).toHaveLength(1);
    expect(h.store.getState().snapshot!.history!.hasNewer).toBe(true);
    expect(h.store.getState().historyError).toBe(HISTORY_BOUNDARY_REFRESH_REQUIRED);
    await h.store.loadNewer();
    expect(h.transport.historyPage).not.toHaveBeenCalled();
  });

  it("LR6: missing boundary proof remains an explicit error, never an invented cursor or background read", async () => {
    const h = await setup(livePage(0, 20, 20));
    h.send(
      Array.from({ length: 130 }, (_, index) => ({
        op: "row.appended" as const,
        row: liveRow(index + 20),
      })),
    );
    expect(h.store.getState().historyError).toBe(HISTORY_BOUNDARY_REFRESH_REQUIRED);
    await h.store.loadOlder();
    expect(h.transport.historyPage).not.toHaveBeenCalled();
  });
});
