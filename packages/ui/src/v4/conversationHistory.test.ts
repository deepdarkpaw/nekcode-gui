import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  V4ConversationHistoryPageResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationProjectionStore,
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "./conversationProjectionStore.js";
import {
  ConversationHistoryWindow,
  HISTORY_WINDOW_LIMITS,
  mergeHistoryRows,
} from "./conversationHistoryWindow.js";
import type { ConversationTransport } from "./transport.js";

vi.mock("@/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), lifecycle: { info: vi.fn(), warn: vi.fn() } },
}));
const watermark = { atSeq: 1, atRevision: 1, atLogEpoch: "epoch" };
function row(position: number, text = `answer ${position}`): ConversationRow {
  return {
    kind: "assistantText",
    rowId: position * 10 + 1,
    entityId: `answer:${position}`,
    turnId: `turn:${position}`,
    createdAt: 1,
    createdAtSeq: 1,
    text,
    state: "complete",
  };
}
function page(start: number, end: number, total = 70): V4ConversationHistoryPageResult {
  const turns = Array.from({ length: end - start }, (_, index) => ({
    turnId: `turn:${index + start}`,
    userEntryId: `entry:${index + start}`,
    position: index + start,
    preview: `Question ${index + start}`,
  }));
  return {
    ...watermark,
    rows: turns.map((turn) => row(turn.position)),
    history: {
      branchRevision: "branch",
      totalTurns: total,
      turns,
      hasOlder: start > 0,
      olderCursor: start > 0 ? `before:${start}` : undefined,
      hasNewer: end < total,
      newerCursor: end < total ? `after:${end}` : undefined,
    },
  };
}
function snapshot(result = page(50, 70)): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "parent",
    logEpoch: "epoch",
    seq: 1,
    revision: 1,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "title", titleSource: "default" },
    config: {
      provider: "test",
      model: "test",
      thought: "off",
      thoughtLevels: ["off"],
      followupMode: "queue",
      mode: "agent",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 9, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window: result.rows,
      totalCount: result.rows.length,
      firstRowId: result.rows[0]?.rowId ?? null,
    },
    history: result.history,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const stores: ConversationProjectionStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});
async function setup(initial = page(50, 70)) {
  const transport = {
    subscribe: vi.fn(async () => ({
      ack: { subscriptionId: "subscription", mode: "snapshot", logEpoch: "epoch" },
    })),
    activate: vi.fn(),
    unsubscribe: vi.fn(async () => {}),
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    historyPage: vi.fn(async () => page(30, 50)),
    historyDirectory: vi.fn(),
    rowsRange: vi.fn(),
  };
  const store = new ConversationProjectionStore(
    "conversation/parent",
    transport as unknown as ConversationTransport,
  );
  stores.push(store);
  await store.connect();
  const sendSnapshot = (value: ConversationSnapshot) =>
    store.handleFrame(
      {
        subscriptionId: "subscription",
        topic: "conversation/parent",
        fromSeq: 0,
        toSeq: value.seq,
        payload: { kind: "snapshot", snapshot: value },
      } as ConversationTopicFrame,
      { deliveryKind: "initial" },
    );
  sendSnapshot(snapshot(initial));
  const deltas = (values: ConversationDelta[]) => {
    const seq = store.getState().snapshot!.seq;
    store.handleFrame({
      subscriptionId: "subscription",
      topic: "conversation/parent",
      fromSeq: seq,
      toSeq: seq + 1,
      payload: { kind: "deltas", deltas: values },
    } as ConversationTopicFrame);
  };
  return { store, transport, sendSnapshot, deltas };
}

describe("renderer bounded history", () => {
  it("RH1: 70 rounds load initial20 then one20,20,10; duplicate top triggers single flight", async () => {
    const { store, transport } = await setup();
    const pending = deferred<V4ConversationHistoryPageResult>();
    transport.historyPage.mockImplementationOnce(() => pending.promise);
    const request = store.loadOlder();
    await store.loadOlder();
    expect(transport.historyPage).toHaveBeenCalledTimes(1);
    expect(transport.historyPage).toHaveBeenLastCalledWith({
      sessionId: "parent",
      turnLimit: 20,
      beforeCursor: "before:50",
    });
    pending.resolve(page(30, 50));
    await request;
    expect(store.countProjectionRows()).toBe(40);
    transport.historyPage.mockResolvedValueOnce(page(10, 30));
    await store.loadOlder();
    transport.historyPage.mockResolvedValueOnce(page(0, 10));
    await store.loadOlder();
    expect(store.countProjectionRows()).toBe(70);
    expect(transport.historyPage).toHaveBeenCalledTimes(3);
    expect(transport.rowsRange).not.toHaveBeenCalled();
    expect(hasOlderRows(store.getState().snapshot)).toBe(false);
  });

  it("RH2/RH4/RH9: overlapping read preserves mutated live rows, control/config/queue and seq", async () => {
    const { store, transport, deltas } = await setup();
    const pending = deferred<V4ConversationHistoryPageResult>();
    transport.historyPage.mockImplementationOnce(() => pending.promise);
    const request = store.loadAround("entry:60");
    deltas([
      { op: "row.delta", rowId: 601, path: "text", append: " live" },
      { op: "row.appended", row: row(70) },
    ]);
    const before = store.getState().snapshot!;
    pending.resolve(page(50, 70));
    await request;
    const after = store.getState().snapshot!;
    expect(after.rows.window.find((item) => item.rowId === 601)).toMatchObject({
      text: "answer 60 live",
    });
    expect(after.rows.window.some((item) => item.rowId === 701)).toBe(true);
    for (const key of ["control", "config", "queue", "usage"] as const)
      expect(after[key]).toBe(before[key]);
    expect(after.seq).toBe(2);
    expect(after.rows.window.length).toBe(21);
  });

  it("RH2/RH9: future read watermark cannot pre-apply text that pending live deltas would append again", async () => {
    const { store, transport, deltas } = await setup();
    const before = store.getState().snapshot;
    transport.historyPage.mockResolvedValueOnce({ ...page(50, 70), atSeq: 2 });
    await store.loadAround("entry:60");
    expect(store.getState().snapshot).toBe(before);
    expect(store.getState().historyError).toContain("ahead of the live subscription");
    deltas([{ op: "row.delta", rowId: 601, path: "text", append: " one" }]);
    transport.historyPage.mockResolvedValueOnce({ ...page(50, 70), atSeq: 2 });
    await store.loadAround("entry:60");
    expect(store.getState().historyError).toBeNull();
  });

  it.each(["delta", "upsert"])(
    "RH2/RH7: stale fetched body for an unloaded %s mutation is rejected visibly",
    async (kind) => {
      const { store, transport, deltas } = await setup();
      const pending = deferred<V4ConversationHistoryPageResult>();
      transport.historyPage.mockImplementationOnce(() => pending.promise);
      const request = store.loadOlder();
      deltas([
        kind === "delta"
          ? { op: "row.delta", rowId: 301, path: "text", append: "new" }
          : { op: "row.upserted", row: row(30, "new") },
      ]);
      const before = store.getState().snapshot;
      pending.resolve(page(30, 50));
      await request;
      expect(store.getState().snapshot).toBe(before);
      expect(store.getState().historyError).toContain("unloaded live mutation");
    },
  );

  it.each(["replacement", "truncation", "restart", "close"])(
    "RH2: late history result is discarded after %s",
    async (kind) => {
      const { store, transport, sendSnapshot, deltas } = await setup();
      const pending = deferred<V4ConversationHistoryPageResult>();
      transport.historyPage.mockImplementationOnce(() => pending.promise);
      const request = store.loadOlder();
      if (kind === "replacement") sendSnapshot(snapshot(page(60, 70)));
      if (kind === "truncation") deltas([{ op: "row.removed", fromRowId: 601 }]);
      if (kind === "restart") await store.connect();
      if (kind === "close") await store.close();
      const before = store.getState().snapshot;
      pending.resolve(page(30, 50));
      await request;
      expect(store.getState().snapshot).toBe(before);
      expect(store.getState().historyRequest).toBe(null);
    },
  );

  it("RH3: six-page/120-turn eviction retains valid opposite-direction cursors", () => {
    const window = new ConversationHistoryWindow();
    let current = window.reset(snapshot(page(180, 200, 200)));
    for (let start = 160; start >= 0; start -= 20)
      current = window.mergePage(current, page(start, start + 20, 200), "older", new Set());
    expect(current.history!.turns).toHaveLength(120);
    expect(current.rows.window).toHaveLength(120);
    expect(current.history).toMatchObject({
      hasOlder: false,
      hasNewer: true,
      newerCursor: "after:120",
      totalTurns: 200,
    });
    current = window.mergePage(current, page(120, 140, 200), "newer", new Set());
    expect(current.history).toMatchObject({
      olderCursor: "before:20",
      hasOlder: true,
      newerCursor: "after:140",
    });
  });

  it("RH3/RH4: an over-budget window drops whole far turns and never folds a turn body", () => {
    const window = new ConversationHistoryWindow();
    const initial = page(0, 2, 2);
    initial.rows = [
      { ...row(0), kind: "turnHeader", rowId: 0, entityId: "header:0" } as ConversationRow,
      row(0, "x".repeat(HISTORY_WINDOW_LIMITS.bytes)),
      { ...row(1), kind: "turnHeader", rowId: 10, entityId: "header:1" } as ConversationRow,
      row(1),
    ];
    const current = window.reset(snapshot(initial));
    expect(current.rows.window.filter((item) => item.turnId === "turn:0")).toHaveLength(0);
    expect(current.rows.window.filter((item) => item.turnId === "turn:1")).toHaveLength(2);
    expect(current.history!.turns.map((turn) => turn.turnId)).toEqual(["turn:1"]);
    expect(current.history!.hasOlder).toBe(true);
  });

  it("RH7: failed and nonadvancing pages retain data and expose retry; success clears error", async () => {
    const { store, transport } = await setup();
    const before = store.getState().snapshot;
    transport.historyPage.mockRejectedValueOnce(new Error("network failed"));
    await store.loadOlder();
    expect(store.getState()).toMatchObject({
      snapshot: before,
      historyError: "network failed",
      loadingOlder: false,
    });
    transport.historyPage.mockResolvedValueOnce(page(50, 70));
    await store.loadOlder();
    expect(store.getState().historyError).toContain("did not advance");
    transport.historyPage.mockResolvedValueOnce(page(30, 50));
    await store.loadOlder();
    expect(store.getState().historyError).toBeNull();
  });

  it("RH8: directory reads preserve parent identity without changing the reading window", async () => {
    const { store, transport } = await setup();
    transport.historyDirectory.mockResolvedValue({
      ...watermark,
      items: [],
      hasMore: false,
      totalTurns: 70,
    });
    const before = store.getState().snapshot;
    await store.readHistoryDirectory({ query: "question", limit: 1000 });
    expect(transport.historyDirectory).toHaveBeenCalledWith({
      sessionId: "parent",
      query: "question",
      limit: 100,
    });
    expect(store.getState().snapshot).toBe(before);
  });

  it("RH10: loadAllOlder refuses normal history hydration rather than reporting loaded-only success", async () => {
    const { store, transport } = await setup();
    expect((await store.loadAllOlder()).status).toBe("retryable-failure");
    expect(transport.historyPage).not.toHaveBeenCalled();
    expect(transport.rowsRange).not.toHaveBeenCalled();
    expect(store.getState().historyError).toContain("export");
  });

  it("RH1/RH3: history.hasOlder is authoritative and incomplete turns never auto-drain", () => {
    const value = snapshot(page(0, 1, 1));
    value.rows.totalCount = 9999;
    value.rows.firstRowId = -100;
    expect(hasOlderRows(value)).toBe(false);
    value.history!.hasOlder = true;
    expect(hasOlderRows(value)).toBe(true);
    expect(shouldAutoLoadIncompleteLeadingTurn(value, false)).toBe(false);
    expect(hasOlderRows(null)).toBe(false);
  });

  it("RH4: explicit newer/around/latest use one page each and preserve subscription watermarks", async () => {
    const { store, transport } = await setup(page(10, 30));
    transport.historyPage.mockResolvedValueOnce(page(30, 50));
    await store.loadNewer();
    expect(transport.historyPage).toHaveBeenLastCalledWith({
      sessionId: "parent",
      afterCursor: "after:30",
      turnLimit: 20,
    });
    transport.historyPage.mockResolvedValueOnce(page(0, 20));
    await store.loadAround("entry:0");
    expect(transport.historyPage).toHaveBeenLastCalledWith({
      sessionId: "parent",
      aroundEntryId: "entry:0",
      turnLimit: 20,
    });
    expect(store.countProjectionRows()).toBe(20);
    transport.historyPage.mockResolvedValueOnce(page(50, 70));
    await store.loadLatest();
    expect(transport.historyPage).toHaveBeenLastCalledWith({ sessionId: "parent", turnLimit: 20 });
    expect(store.getState().snapshot!.seq).toBe(1);
    expect(store.getState().snapshot!.history!.turns[0]?.position).toBe(50);
  });

  it("RH3: live-only turn overflow is bounded and explicitly requires fresh host cursors, never fabricated ones", async () => {
    const { store, transport, deltas } = await setup(page(0, 20, 20));
    deltas(
      Array.from({ length: 150 }, (_, index) => ({
        op: "row.appended" as const,
        row: row(index + 20),
      })),
    );
    expect(new Set(store.getState().snapshot!.rows.window.map((item) => item.turnId)).size).toBe(
      120,
    );
    expect(store.getState().snapshot!.history!.hasOlder).toBe(true);
    expect(store.getState().historyError).toContain("cursor boundary");
    await store.loadOlder();
    expect(transport.historyPage).not.toHaveBeenCalled();
    transport.historyPage.mockResolvedValueOnce({ ...page(150, 170, 170), atSeq: 2 });
    await store.loadLatest();
    expect(store.getState().historyError).toBeNull();
    expect(store.getState().snapshot!.history!.olderCursor).toBe("before:150");
  });

  it("RH3: overlapping page membership preserves exact cursors after neighbor eviction", () => {
    const window = new ConversationHistoryWindow();
    let value = window.reset(snapshot(page(100, 120, 200)));
    for (let start = 81; start >= 5; start -= 19)
      value = window.mergePage(value, page(start, start + 20, 200), "older", new Set());
    value = window.mergePage(value, page(120, 140, 200), "newer", new Set());
    value = window.mergePage(value, page(140, 160, 200), "newer", new Set());
    const start = value.history!.turns[0]!.position;
    expect(value.history!.olderCursor).toBe(`before:${start}`);
    expect(value.rows.window[0]!.turnId).toBe(`turn:${start}`);
  });

  it("RH3/RH9: token accounting serializes neither snapshot nor growing row after page admission", () => {
    const window = new ConversationHistoryWindow();
    const before = window.reset(snapshot(page(0, 1, 1)));
    const next = {
      ...before,
      rows: {
        ...before.rows,
        window: [{ ...before.rows.window[0]!, text: "answer 0more" } as ConversationRow],
      },
    };
    const spy = vi.spyOn(JSON, "stringify");
    window.accountDeltas(before, next, [
      { op: "row.delta", rowId: 1, path: "text", append: "more" },
    ]);
    window.bound(next);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("RH2: duplicate entity rows merge once and unchanged data is immutable", () => {
    const old = row(1);
    const updated = { ...old, rowId: 999, text: "updated" } as ConversationRow;
    expect(mergeHistoryRows([old], [updated], new Set(), false)).toEqual([updated]);
    expect(old.rowId).toBe(11);
  });
});
