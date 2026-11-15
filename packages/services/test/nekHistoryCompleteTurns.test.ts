import assert from "node:assert/strict";
import test from "node:test";
import type { NekHistoryPage, NekSessionEntry } from "@zcode/shared/nek-protocol";
import type {
  ConversationRow,
  ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { validateHistoryDisplay } from "../src/nek-agent/projection/nekHistoryDisplay.js";
import {
  historyMetadata,
  projectHistory,
} from "../src/nek-agent/projection/nekHistoryProjection.js";
import { NekProjectionStore } from "../src/nek-agent/projection/nekProjectionStore.js";
import { buildAssistantTextRow, buildTurnHeaderRow } from "../src/nek-agent/projection/nekRows.js";
import {
  HISTORY_PAGE_MAX_BYTES,
  NekHistoryReadError,
} from "../src/nek-agent/service/nekHistoryRpc.js";
import { fixtureHistory } from "./nekHistoryFixture.js";
import { entry, harness, params, target } from "./nekSessionHarness.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function completeEntries(): NekSessionEntry[] {
  return [
    {
      ...entry,
      id: "u1",
      parentId: null,
      message: { role: "user", timestamp: 1, content: "first" },
    },
    {
      ...entry,
      id: "a1",
      parentId: "u1",
      message: {
        role: "assistant",
        timestamp: 2,
        api: "test",
        provider: "mock",
        model: "mock",
        usage,
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "text", text: "before tool" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "image.png" } },
        ],
      },
    },
    {
      ...entry,
      id: "r1",
      parentId: "a1",
      message: {
        role: "toolResult",
        timestamp: 3,
        toolCallId: "t1",
        toolName: "read",
        isError: false,
        content: [
          { type: "text", text: "complete tool output" },
          { type: "image", mimeType: "image/png" },
        ],
      },
    },
    {
      ...entry,
      id: "a2",
      parentId: "r1",
      message: {
        role: "assistant",
        timestamp: 4,
        api: "test",
        provider: "mock",
        model: "mock",
        usage,
        stopReason: "stop",
        content: [{ type: "text", text: "after tool" }],
      },
    },
    {
      ...entry,
      id: "u2",
      parentId: "a2",
      message: { role: "user", timestamp: 5, content: "second" },
    },
    {
      ...entry,
      id: "a3",
      parentId: "u2",
      message: {
        role: "assistant",
        timestamp: 6,
        api: "test",
        provider: "mock",
        model: "mock",
        usage,
        stopReason: "stop",
        content: [{ type: "text", text: "second answer" }],
      },
    },
  ];
}

test("HT1/HT6: complete-turn pages render all entry bodies and tool images need no data", () => {
  const entries = completeEntries();
  const page = fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage;
  const rows = projectHistory({
    sessionId: page.sessionId,
    turns: page.turns,
    entries: page.entries,
  });
  assert.deepEqual(
    rows.map((row) => row.kind),
    [
      "turnHeader",
      "userInput",
      "reasoning",
      "assistantText",
      "toolCall",
      "assistantText",
      "turnHeader",
      "userInput",
      "assistantText",
    ],
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "assistantText").map((row) => row.text),
    ["before tool", "after tool", "second answer"],
  );
  const tool = rows.find((row) => row.kind === "toolCall");
  assert.equal(tool?.output?.text, "complete tool output");
  assert.equal(tool?.status, "success");
  assert.equal(rows.find((row) => row.kind === "reasoning")?.text, "reason");
  assert.ok(rows.every((row) => !("historyContent" in row)));
  assert.ok(historyMetadata(page).turns.every((turn) => !("continuationCursor" in turn)));
  assert.doesNotThrow(() => validateHistoryDisplay(entries[2]));
  for (const role of ["user", "custom"])
    assert.throws(
      () =>
        validateHistoryDisplay({
          ...entry,
          message: {
            role,
            timestamp: 1,
            content: [{ type: "image", mimeType: "image/png" }],
            display: true,
            customType: "test",
          },
        }),
      /data/,
    );
});

test("HT1: initial and older pages retain every row of 20 complete turns beyond the legacy 60-row tail", async () => {
  const entries: NekSessionEntry[] = [];
  for (let turn = 0; turn < 25; turn++) {
    const first = completeEntries().slice(0, 4);
    for (const source of first) {
      const id = `${source.id}-${turn}`;
      const copy = structuredClone(source);
      copy.id = id;
      copy.parentId = entries.at(-1)?.id ?? null;
      if (copy.type === "message" && copy.message.role === "assistant")
        for (const block of copy.message.content)
          if (block.type === "toolCall") block.id = `t1-${turn}`;
      if (copy.type === "message" && copy.message.role === "toolResult")
        copy.message.toolCallId = `t1-${turn}`;
      entries.push(copy);
    }
  }
  const h = harness({ entries });
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    const subscription = await h.adapter.subscribeConversationV4(params);
    const snapshot = await h.adapter.readNekSession(params);
    const initial = frames[0];
    assert.ok(initial?.kind === "complete" && initial.frame.payload.kind === "snapshot");
    assert.equal(initial.frame.payload.snapshot.rows.window.length, 120);
    assert.equal(subscription.ack.openTiming?.snapshotRowCount, 120);
    assert.equal(snapshot.history?.turns.length, 20);
    assert.equal(snapshot.rows.window.length, 120);
    assert.equal(snapshot.rows.window.filter((row) => row.kind === "toolCall").length, 20);
    const page = await h.adapter.conversationHistoryPageV4({
      ...params,
      beforeCursor: snapshot.history?.olderCursor,
    });
    assert.equal(page.history.turns.length, 5);
    assert.equal(page.rows.length, 30);
    assert.equal(page.history.hasOlder, false);
    assert.ok(page.rows.at(-1)!.rowId < snapshot.rows.window[0]!.rowId);
    assert.ok(
      h.sessions[0]!.commands.filter(
        (command) => command.type === "read_history_page" && command.view !== "summary",
      ).every((command) => command.maxBytes === HISTORY_PAGE_MAX_BYTES),
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("HT3: RESPONSE_LIMIT remains a visible retryable NekHistoryReadError without partial rendering", async () => {
  let fail = false;
  const h = harness({
    entries: completeEntries(),
    historyOverride: (command) =>
      fail && command.type === "read_history_page"
        ? {
            ok: false,
            error: { code: "RESPONSE_LIMIT", message: "complete turn exceeds page budget" },
          }
        : undefined,
  });
  try {
    const initial = await h.adapter.readNekSession(params);
    const before = h.sessions[0]!.commands.length;
    fail = true;
    await assert.rejects(h.adapter.conversationHistoryPageV4(params), (error: unknown) => {
      assert.ok(error instanceof NekHistoryReadError);
      assert.equal(error.name, "NekHistoryReadError");
      assert.equal(error.code, "RESPONSE_LIMIT");
      assert.match(error.message, /complete turn exceeds/);
      return true;
    });
    const reads = h.sessions[0]!.commands.slice(before);
    assert.equal(reads.length, 1, "no fallback reads or partial projection");
    assert.equal(reads[0]?.maxBytes, HISTORY_PAGE_MAX_BYTES);
    fail = false;
    assert.deepEqual((await h.adapter.readNekSession(params)).rows.window, initial.rows.window);
    assert.equal((await h.adapter.conversationHistoryPageV4(params)).history.turns.length, 2);
  } finally {
    await h.adapter.dispose();
  }
});

/** Three turns whose projected text alone is ~18 MB: the latest page must shrink by whole turns. */
function heavyTurns(): NekSessionEntry[] {
  const entries: NekSessionEntry[] = [];
  for (let turn = 0; turn < 3; turn++) {
    entries.push(
      {
        ...entry,
        id: `hu${turn}`,
        parentId: entries.at(-1)?.id ?? null,
        message: { role: "user", timestamp: turn * 10 + 1, content: `heavy question ${turn}` },
      },
      {
        ...entry,
        id: `ha${turn}`,
        parentId: `hu${turn}`,
        message: {
          role: "assistant",
          timestamp: turn * 10 + 2,
          api: "test",
          provider: "mock",
          model: "mock",
          usage,
          stopReason: "stop",
          content: [{ type: "text", text: `${turn}`.repeat(6 * 1024 * 1024) }],
        },
      },
    );
  }
  return entries;
}

test("HT7: a page projecting beyond the bound is reread with fewer whole turns, never cut", async () => {
  const h = harness({ entries: heavyTurns() });
  try {
    const snapshot = await h.adapter.readNekSession(params);
    assert.deepEqual(
      snapshot.history?.turns.map((turn) => turn.turnId),
      ["turn:hu1", "turn:hu2"],
    );
    const initialReads = h.sessions[0]!.commands.filter(
      (command) => command.type === "read_history_page" && command.view === undefined,
    );
    assert.deepEqual(
      initialReads.map((command) => command.turnLimit),
      [20, 2],
    );
    const before = h.sessions[0]!.commands.length;
    const page = await h.adapter.conversationHistoryPageV4(params);
    assert.deepEqual(
      page.history.turns.map((turn) => turn.turnId),
      ["turn:hu1", "turn:hu2"],
    );
    for (const turn of ["turn:hu1", "turn:hu2"]) {
      const text = page.rows.find((row) => row.turnId === turn && row.kind === "assistantText");
      assert.equal(text?.kind === "assistantText" && text.text.length, 6 * 1024 * 1024);
    }
    assert.deepEqual(
      h.sessions[0]!.commands.slice(before)
        .filter((command) => command.type === "read_history_page")
        .map((command) => command.turnLimit),
      [20, 2],
    );
  } finally {
    await h.adapter.dispose();
  }
});

function store(maxWindowRows = 5000): NekProjectionStore {
  const projector = new NekConversationProjector({ sessionId: "eviction" });
  const snapshot = projector.snapshot();
  projector.dispose();
  return new NekProjectionStore({
    sessionId: "eviction",
    logEpoch: "epoch",
    maxWindowRows,
    initialState: {
      title: "",
      config: snapshot.config,
      usage: snapshot.usage,
      plan: snapshot.plan,
      control: snapshot.control,
      queue: snapshot.queue,
    },
  });
}
function turnRows(
  turnId: string,
  firstRowId: number,
  bytes: number,
  running = false,
): ConversationRow[] {
  const identity = { turnId, rowId: firstRowId, entityId: turnId, createdAt: 1 };
  return [
    buildTurnHeaderRow(identity, { state: running ? "running" : "completedSuccess" }),
    buildAssistantTextRow(
      { ...identity, rowId: firstRowId + 1, entityId: `${turnId}:text` },
      { text: "x".repeat(bytes), state: "complete" },
    ),
    buildAssistantTextRow(
      { ...identity, rowId: firstRowId + 2, entityId: `${turnId}:tail` },
      { text: "tail", state: "complete" },
    ),
  ];
}

test("HT5: 16 MB host eviction removes all rows of the oldest inactive turn, never just its body", () => {
  const owner = store();
  const oldest = turnRows("oldest", 1, 6 * 1024 * 1024);
  const middle = turnRows("middle", 4, 5 * 1024 * 1024);
  const active = turnRows("active", 7, 4 * 1024 * 1024, true);
  for (const row of [...oldest, ...middle, ...active]) owner.add(row);
  owner.markAllEmitted();
  owner.appendStream(8, "text", "x".repeat(2 * 1024 * 1024));
  assert.deepEqual(
    owner.window.map((row) => row.turnId),
    [...Array(3).fill("middle"), ...Array(3).fill("active")],
  );
  assert.equal(owner.rowCount, 6);
  const removed = owner.drainDeltas().find((delta) => delta.op === "rows.removed");
  assert.deepEqual(removed?.op === "rows.removed" && removed.rowIds.toSorted(), [1, 2, 3]);
  assert.equal(owner.findRowId("oldest"), undefined);
  assert.equal(owner.findRowId("oldest:tail"), undefined);
  assert.throws(
    () => owner.appendStream(8, "text", "x".repeat(11 * 1024 * 1024)),
    /live turn exceeds 16 MB/,
  );
  assert.equal(owner.window.filter((row) => row.turnId === "active").length, 3);
});

test("HT5: the active live turn alone exceeding 16 MB fails visibly instead of folding any body", () => {
  const owner = store();
  for (const row of turnRows("active", 1, 8 * 1024 * 1024, true)) owner.add(row);
  owner.update(3, (row) =>
    row.kind === "assistantText" ? { ...row, text: "x".repeat(7 * 1024 * 1024) } : row,
  );
  assert.throws(
    () => owner.appendStream(3, "text", "x".repeat(2 * 1024 * 1024)),
    /live turn exceeds 16 MB/,
  );
  assert.equal(owner.window.length, 3);
  const body = owner.getRow(3);
  assert.equal(body?.kind === "assistantText" && body.text.length, 7 * 1024 * 1024);
});

test("HT5: row-count eviction also removes whole turns and pins every row of a running turn", () => {
  const owner = store(7);
  for (const row of turnRows("pinned", 1, 1, true)) owner.add(row);
  for (const row of turnRows("old", 4, 1)) owner.add(row);
  for (const row of turnRows("new", 7, 1)) owner.add(row);
  assert.deepEqual(
    owner.window.map((row) => row.turnId),
    [...Array(3).fill("pinned"), ...Array(3).fill("new")],
  );
});
