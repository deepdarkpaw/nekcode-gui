import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_V4_LIMITS,
  conversationTopicFrameSchema,
  type ConversationSnapshot,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { NekSessionEntry } from "@zcode/shared/nek-protocol";
import { entry, harness, params, target } from "./nekSessionHarness.js";

/** 多个真实 user 边界构成的可确定重放历史；不依赖 CLI 或模型。 */
function historyEntries(count = 160): NekSessionEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...entry,
    id: `user-${index + 1}`,
    parentId: index === 0 ? null : `user-${index}`,
    message: { ...entry.message, content: `prompt ${index + 1}`, timestamp: index + 1 },
  }));
}

function snapshotOf(wire: ConversationTopicWireCandidate | undefined): ConversationSnapshot {
  assert.ok(wire?.kind === "complete");
  conversationTopicFrameSchema.parse(wire.frame);
  assert.equal(wire.frame.payload.kind, "snapshot");
  if (wire.frame.payload.kind !== "snapshot") throw new Error("expected snapshot");
  return wire.frame.payload.snapshot;
}

test("HP-1: initial wire tail preserves metadata and leaves the authoritative history intact", async () => {
  const h = harness({ entries: historyEntries() });
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    const subscription = await h.adapter.subscribeConversationV4(params);
    const full = await h.adapter.readNekSession(params);
    const initial = snapshotOf(frames[0]);
    assert.equal(subscription.ack.openTiming?.snapshotRowCount, initial.rows.window.length);
    assert.ok(full.rows.window.length > PROTOCOL_V4_LIMITS.snapshotTailWindowRows);
    assert.deepEqual(initial, {
      ...full,
      rows: {
        ...full.rows,
        window: full.rows.window.slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows),
      },
    });
    assert.ok(initial.rows.window[0]!.rowId > initial.rows.firstRowId!);
    assert.deepEqual((await h.adapter.readNekSession(params)).rows, full.rows);
  } finally {
    await h.adapter.dispose();
  }
});

test("HP-2: existing rowsRange reconstructs every omitted row with the same identities and watermark", async () => {
  const h = harness({ entries: historyEntries() });
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    await h.adapter.subscribeConversationV4(params);
    const initial = snapshotOf(frames[0]);
    const full = await h.adapter.readNekSession(params);
    let loaded = [...initial.rows.window];
    let hasMore = true;
    let pages = 0;
    while (hasMore) {
      assert.ok(pages++ < 10, "cursor must advance to the start of history");
      const beforeRowId = loaded[0]!.rowId;
      const page = await h.adapter.conversationRowsRangeV4({ ...params, beforeRowId, limit: 100 });
      assert.ok(page.rows.length > 0 && page.rows.length <= 100);
      assert.ok(page.rows.every((row) => row.rowId < beforeRowId));
      assert.equal(page.atLogEpoch, full.logEpoch);
      assert.equal(page.atSeq, full.seq);
      assert.equal(page.atRevision, full.revision);
      loaded = [...page.rows, ...loaded];
      hasMore = page.hasMore;
    }
    assert.ok(pages > 1);
    assert.deepEqual(loaded, full.rows.window);
    assert.equal(new Set(loaded.map((row) => row.rowId)).size, loaded.length);
  } finally {
    await h.adapter.dispose();
  }
});

test("HP-2: numeric cursors need not identify an existing row, and page size stays bounded", async () => {
  const h = harness({ entries: historyEntries() });
  try {
    const full = await h.adapter.readNekSession(params);
    const page = await h.adapter.conversationRowsRangeV4({
      ...params,
      beforeRowId: full.rows.window.at(-1)!.rowId + 10,
      limit: 10_000,
    });
    assert.deepEqual(page.rows, full.rows.window.slice(-PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
    assert.equal(page.hasMore, true);
    const atStart = await h.adapter.conversationRowsRangeV4({
      ...params,
      beforeRowId: full.rows.firstRowId!,
      limit: 20,
    });
    assert.deepEqual(atStart.rows, []);
    assert.equal(atStart.hasMore, false);
  } finally {
    await h.adapter.dispose();
  }
});

test("HP-3: live deltas keep their watermark and resync uses the same wire tail boundary", async () => {
  const h = harness({ entries: historyEntries() });
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    const subscription = await h.adapter.subscribeConversationV4(params);
    const binding = await h.adapter.ensureNekSessionBinding(params, params.sessionId);
    const projector = h.adapter.service.commandContext().target(binding.sessionKey).projector;
    assert.ok(projector);
    h.sessions[0]!.emit({
      type: "message_start",
      message: { role: "user", content: "live continuation", timestamp: 1000 },
    });
    await new Promise((resolve) => setImmediate(resolve));
    projector.flushNow();
    const lastLive = frames.at(-1);
    assert.ok(lastLive?.kind === "complete" && lastLive.frame.payload.kind === "deltas");
    const full = await h.adapter.readNekSession(params);
    const page = await h.adapter.conversationRowsRangeV4({ ...params, limit: 200 });
    assert.equal(page.atSeq, lastLive.frame.toSeq);
    assert.deepEqual(page.rows, full.rows.window.slice(-200));
    await h.adapter.resyncConversationV4({
      ...params,
      subscriptionId: subscription.ack.subscriptionId,
      base: { logEpoch: full.logEpoch, seq: full.seq },
    });
    const recovery = frames.at(-1);
    assert.ok(recovery?.kind === "complete" && recovery.deliveryKind === "recovery");
    assert.ok(recovery.logicalFrameOrdinal > lastLive.logicalFrameOrdinal);
    assert.deepEqual(snapshotOf(recovery).rows, {
      ...full.rows,
      window: full.rows.window.slice(-PROTOCOL_V4_LIMITS.snapshotTailWindowRows),
    });
  } finally {
    await h.adapter.dispose();
  }
});

test("HP-3: online authoritative rebuilds cross the same snapshot tail boundary", async () => {
  const entries = historyEntries();
  const h = harness({ entries });
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    await h.adapter.subscribeConversationV4(params);
    const binding = await h.adapter.ensureNekSessionBinding(params, params.sessionId);
    const projector = h.adapter.service.commandContext().target(binding.sessionKey).projector;
    assert.ok(projector);
    projector.loadSnapshot({ entries, leafId: entries.at(-1)!.id });
    const online = frames.at(-1);
    assert.ok(online?.kind === "complete" && online.deliveryKind === "online");
    const full = await h.adapter.readNekSession(params);
    assert.equal(snapshotOf(online).rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows);
    assert.equal(snapshotOf(online).rows.totalCount, full.rows.totalCount);
    assert.ok(full.rows.window.length > PROTOCOL_V4_LIMITS.snapshotTailWindowRows);
  } finally {
    await h.adapter.dispose();
  }
});

test("HP-4: paging back to a child preserves its original spawn turn and parent tool anchor", async () => {
  const entries = historyEntries(80);
  const child = {
    id: "history-child",
    type: "worker",
    description: "inspect history",
    background: true,
    status: "completed",
    startedAt: 1,
    endedAt: 2,
  } as const;
  entries[1]!.parentId = "spawn-result";
  entries.splice(
    1,
    0,
    {
      type: "message",
      id: "spawn",
      parentId: entries[0]!.id,
      timestamp: entry.timestamp,
      message: {
        role: "assistant",
        timestamp: 1,
        api: "openai-completions",
        provider: "test",
        model: "test",
        content: [
          {
            type: "toolCall",
            id: "spawn-call",
            name: "subagent",
            arguments: { description: child.description },
          },
        ],
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    },
    {
      type: "message",
      id: "spawn-result",
      parentId: "spawn",
      timestamp: entry.timestamp,
      message: {
        role: "toolResult",
        toolCallId: "spawn-call",
        toolName: "subagent",
        timestamp: 2,
        content: [{ type: "text", text: "completed" }],
        details: { subagent: child },
        isError: false,
      },
    },
  );
  const h = harness({ entries });
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    await h.adapter.subscribeConversationV4(params);
    const initial = snapshotOf(frames[0]);
    const full = await h.adapter.readNekSession(params);
    const source = full.rows.window.find((row) => row.kind === "subagent");
    const spawn = full.rows.window.find(
      (row) => row.kind === "toolCall" && row.toolCallId === "spawn-call",
    );
    assert.ok(source?.kind === "subagent" && spawn);
    assert.equal(
      initial.rows.window.some((row) => row.rowId === source.rowId),
      false,
    );
    const page = await h.adapter.conversationRowsRangeV4({
      ...params,
      beforeRowId: initial.rows.window[0]!.rowId,
      limit: 200,
    });
    const recovered = page.rows.find((row) => row.rowId === source.rowId);
    assert.deepEqual(recovered, source);
    assert.equal(source.turnId, spawn.turnId);
    assert.equal(source.parentToolCallId, "spawn-call");
  } finally {
    await h.adapter.dispose();
  }
});

test("HP-4: locked history supports the same wire tail and pages without a session process", async () => {
  const h = harness({
    entries: historyEntries(),
    lockedBy: { pid: 42, hostname: "other", kind: "rpc", startedAt: entry.timestamp },
  });
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    await h.adapter.subscribeConversationV4(params);
    const initial = snapshotOf(frames[0]);
    assert.equal(initial.rows.window.length, PROTOCOL_V4_LIMITS.snapshotTailWindowRows);
    assert.equal(initial.control.readOnly?.reason, "locked");
    const page = await h.adapter.conversationRowsRangeV4({
      ...params,
      beforeRowId: initial.rows.window[0]!.rowId,
      limit: 200,
    });
    assert.equal(page.rows.length, 200);
    assert.equal(h.sessions.length, 0);
  } finally {
    await h.adapter.dispose();
  }
});
