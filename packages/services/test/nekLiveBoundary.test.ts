import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryMetadata,
  NekHistoryPage,
  NekHistorySummaryPage,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import { ConversationHistoryWindow } from "../../ui/src/v4/conversationHistoryWindow.js";
import { applyConversationLiveDeltas } from "../../ui/src/v4/conversationLiveDeltas.js";

const session = { ...historySummary, id: "parent" };
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function user(position: number): NekSessionEntry {
  return {
    type: "message",
    id: `u${position}`,
    parentId: position ? `a${position - 1}` : null,
    timestamp: "2026-11-15T00:00:00Z",
    message: { role: "user", timestamp: position * 2, content: `task ${position}` },
  };
}
function answer(position: number): NekSessionEntry {
  return {
    type: "message",
    id: `a${position}`,
    parentId: `u${position}`,
    timestamp: "2026-11-15T00:00:00Z",
    message: {
      role: "assistant",
      timestamp: position * 2 + 1,
      api: "openai-responses",
      provider: "mock",
      model: "mock",
      stopReason: "stop",
      usage,
      content: [{ type: "text", text: `answer ${position}` }],
    },
  };
}
function setup() {
  const entries = Array.from({ length: 30 }, (_, position) => [
    user(position),
    answer(position),
  ]).flat();
  const projector = new NekConversationProjector({
    sessionId: session.id,
    schedule: () => () => {},
  });
  projector.loadHistory({
    page: fixtureHistory(entries, { type: "read_history_page" }, session) as NekHistoryPage,
    metadata: fixtureHistory(
      entries,
      { type: "read_session_metadata" },
      session,
    ) as NekHistoryMetadata,
  });
  const window = new ConversationHistoryWindow();
  let current = window.reset(projector.snapshot());
  const detach = projector.subscribe((frame) => {
    if (frame.payload.kind === "snapshot") {
      current = window.reset(frame.payload.snapshot);
      return;
    }
    let next = applyConversationLiveDeltas(current, frame.payload.deltas);
    for (const delta of frame.payload.deltas)
      if (delta.op === "state.updated" && delta.patch.history)
        next = window.observeBoundary(next, delta.patch.history, frame.toSeq, next.revision);
    current = window.bound({ ...next, seq: frame.toSeq });
  });
  const close = () => {
    detach();
    projector.dispose();
  };
  return { projector, window, entries, current: () => current, close };
}

test("LCB1: a metadata-only live start can become the reading anchor without retiring valid cursors", () => {
  const h = setup();
  try {
    h.projector.handleHistoryEvent(
      { type: "message_start", message: { role: "user", timestamp: 60 } },
      [{ pointer: "/message", reason: "persisted_body", resolution: "history" }],
      "live:epoch:1",
    );
    h.projector.flushNow();
    h.window.setViewportAnchor({ turnId: "turn:live:epoch:1", followingLatest: false });
    const current = h.window.bound(h.current());
    assert.equal(h.window.needsBoundaryRefresh, false);
    assert.equal(current.history!.olderCursor, "10");
    assert.equal(current.history!.hasNewer, false);
    assert.ok(current.rows.window.some((row) => row.turnId === "turn:live:epoch:1"));
  } finally {
    h.close();
  }
});

test("LCB2: a canonical user append uses the turn ordinal, not its storage entry position", () => {
  const h = setup();
  try {
    h.projector.handleEvent({ type: "entry_appended", entry: user(30) });
    h.projector.flushNow();
    assert.equal(h.projector.snapshot().history!.turns.at(-1)!.position, 30);
    assert.equal(h.projector.snapshot().history!.totalTurns, 31);
  } finally {
    h.close();
  }
});

test("LCB2/LCB3: accepted target publishes its turn with its body, not future source capabilities", () => {
  const h = setup();
  try {
    const before = h.projector.snapshot().history!;
    // The read can observe more persisted entries than this locator has consumed.
    const future = [...h.entries, user(30), answer(30), user(31)];
    const page = fixtureHistory(
      future,
      {
        type: "read_history_page",
        view: "target",
        aroundEntryId: "u30",
      },
      session,
    ) as NekHistoryPage;
    h.projector.applyHistoryTarget(page, "u30");
    h.projector.flushNow();
    const history = h.projector.snapshot().history!;
    assert.equal(history.totalTurns, 31);
    assert.equal(history.branchRevision, before.branchRevision);
    assert.equal(history.observationCursor, before.observationCursor);
    assert.equal(history.olderCursor, undefined, "old cursor cannot move to the shifted edge");
    assert.equal(h.current().history!.olderCursor, "10", "renderer retains its real loaded edge");
    assert.deepEqual(history.turns.at(-1), {
      turnId: "turn:u30",
      userEntryId: "u30",
      position: 30,
      preview: "task 30",
    });
    assert.ok(h.current().history!.turns.some((turn) => turn.turnId === "turn:u30"));
    h.window.setViewportAnchor({ turnId: "turn:u30", followingLatest: false });
    assert.equal(h.window.bound(h.current()).history!.hasNewer, false);
    assert.equal(h.window.needsBoundaryRefresh, false);
    h.projector.applyHistoryTarget(page, "u30");
    h.projector.flushNow();
    assert.deepEqual(h.projector.snapshot().history, history);
    const summary = fixtureHistory(
      [...h.entries, user(30)],
      {
        type: "read_history_page",
        view: "summary",
      },
      session,
    ) as NekHistorySummaryPage;
    assert.equal(h.projector.applyHistorySummary(summary), true);
    h.projector.flushNow();
    assert.equal(h.current().history!.totalTurns, 31);
    assert.equal(h.window.needsBoundaryRefresh, false);
  } finally {
    h.close();
  }
});
