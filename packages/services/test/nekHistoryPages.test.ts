import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryMetadata,
  NekHistoryPage,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { projectHistory, historyRowId } from "../src/nek-agent/projection/nekHistoryProjection.js";
import {
  boundHistoryResult,
  requireHistoryPages,
  historyResult,
} from "../src/nek-agent/service/nekHistoryRpc.js";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import { entry, harness, params, sessionId, sessionPath } from "./nekSessionHarness.js";

const users = (count: number): NekSessionEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    ...entry,
    id: `u${i}`,
    parentId: i ? `u${i - 1}` : null,
    message: { role: "user", content: `same prompt ${i}`, timestamp: 1 },
  }));
function page(entries: NekSessionEntry[], extra = {}): NekHistoryPage {
  return fixtureHistory(entries, { type: "read_history_page", ...extra }) as NekHistoryPage;
}
function metadata(entries: NekSessionEntry[]): NekHistoryMetadata {
  return fixtureHistory(entries, { type: "read_session_metadata" }) as NekHistoryMetadata;
}

test("HS1: metadata-only restore still rejects a partial lock holder", () => {
  assert.throws(
    () => historyResult({ ok: true, lockedBy: { pid: 42 } }),
    /invalid history lock metadata/,
  );
  assert.doesNotThrow(() =>
    historyResult({
      ok: true,
      lockedBy: {
        pid: 42,
        hostname: "fixture",
        kind: "rpc",
        startedAt: "2026-11-14T00:00:00.000Z",
      },
    }),
  );
});

for (const count of [70, 1000])
  test(`HS1/HS6: ${count} rounds open latest20 without old APIs or body cache growth`, async () => {
    const h = harness({ entries: users(count) });
    try {
      const snapshot = await h.adapter.readNekSession(params);
      assert.equal(snapshot.history?.turns.length, 20);
      assert.equal(snapshot.history?.totalTurns, count);
      assert.equal(snapshot.rows.window.length, 40);
      const lengths = [20];
      let cursor = snapshot.history?.olderCursor;
      if (count === 70)
        while (cursor) {
          const response = await h.adapter.conversationHistoryPageV4({
            ...params,
            beforeCursor: cursor,
          });
          lengths.push(response.history.turns.length);
          assert.ok(
            response.rows.every((row) => row.productTurnId && row.productTurnId === row.turnId),
            "source history retains canonical product turn ownership for export",
          );
          cursor = response.history.olderCursor;
        }
      if (count === 70) assert.deepEqual(lengths, [20, 20, 20, 10]);
      assert.equal(
        (await h.adapter.readNekSession(params)).rows.window.length,
        40,
        "old pages are request-local, not retained",
      );
      const commands = [...h.control.commands, ...h.sessions.flatMap((item) => item.commands)];
      assert.ok(
        !commands.some(
          (command) => command.type === "get_entries" || command.type === "read_session_snapshot",
        ),
      );
      assert.ok(
        commands
          .filter((command) => command.type === "read_history_page")
          .every((command) => command.turnLimit === 20),
      );
    } finally {
      await h.adapter.dispose();
    }
  });

test("HS2: root/subtree omissions are explicit deferred content, never cast to model entries or success", () => {
  const source = page(users(2));
  source.entries[1] = {
    ...source.entries[1]!,
    entry: { message: null },
    omissions: [
      {
        pointer: "/message",
        ref: "opaque-ref",
        totalBytes: 90_000_000,
        mediaType: "application/json",
        encoding: "base64",
      },
    ],
  };
  source.turns[1]!.header = source.entries[1]!;
  const rows = projectHistory({
    sessionId: source.sessionId,
    turns: source.turns,
    entries: source.entries,
  });
  const deferred = rows.find((row) => row.historyContent);
  assert.equal(deferred?.historyContent?.[0]?.totalBytes, 90_000_000);
  assert.equal(deferred?.historyContent?.[0]?.entryId, "u1");
  assert.equal(rows.filter((row) => row.kind === "turnHeader").length, 2);
  assert.ok(JSON.stringify(rows).length < 10_000);
  assert.throws(() =>
    projectHistory({
      sessionId: "s1",
      turns: source.turns,
      entries: [{ ...source.entries[0]!, entry: { type: "message", id: "other" } }],
    }),
  );
});

test("HS2: cumulative usage and accepted selection come from full branch metadata, not latest20", () => {
  const source = page(users(70));
  const meta = metadata(users(70));
  meta.usage = {
    input: 9000,
    output: 1000,
    cacheRead: 2000,
    cacheWrite: 3000,
    totalTokens: 15000,
    cost: 2,
  };
  meta.selection = { model: { provider: "acme", modelId: "chosen" }, thinkingLevel: "high" };
  const projector = new NekConversationProjector({ sessionId: "s1" });
  try {
    projector.loadHistory({ page: source, metadata: meta });
    assert.deepEqual(projector.snapshot().usage.cumulative, {
      inputTokens: 9000,
      outputTokens: 1000,
      cacheReadTokens: 2000,
      cacheWriteTokens: 3000,
    });
    assert.equal(projector.snapshot().config.modelSelection?.modelId, "chosen");
  } finally {
    projector.dispose();
  }
});

test("HS3: older-first, around and duplicate timestamps preserve sparse source row/turn identities", () => {
  const entries = users(70);
  const older = page(entries, { aroundEntryId: "u0" });
  const newest = page(entries);
  const oldRows = projectHistory({ sessionId: "s1", turns: older.turns, entries: older.entries });
  const newRows = projectHistory({ sessionId: "s1", turns: newest.turns, entries: newest.entries });
  assert.ok(oldRows.at(-1)!.rowId < newRows[0]!.rowId);
  assert.equal(
    new Set([...oldRows, ...newRows].map((row) => row.rowId)).size,
    oldRows.length + newRows.length,
  );
  assert.equal(newRows[0]?.turnId, "turn:u50");
  assert.throws(() => historyRowId(Number.MAX_SAFE_INTEGER, 1), /overflow/);
});

test("HS3: partial long turn repeats real owning header and seeds tool input from admitted anchors", () => {
  const root = users(1)[0]!;
  const call: NekSessionEntry = {
    ...entry,
    id: "call",
    parentId: root.id,
    message: {
      role: "assistant",
      timestamp: 2,
      api: "test",
      provider: "acme",
      model: "chosen",
      content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "file" } }],
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
  };
  const result: NekSessionEntry = {
    ...entry,
    id: "result",
    parentId: call.id,
    message: {
      role: "toolResult",
      timestamp: 3,
      toolCallId: "t1",
      toolName: "read",
      content: [{ type: "text", text: "body" }],
      isError: false,
    },
  };
  const full = page([root, call, result]);
  const first = projectHistory({
    sessionId: "s1",
    turns: full.turns,
    entries: full.entries.slice(0, 2),
  });
  const next = projectHistory({
    sessionId: "s1",
    turns: full.turns,
    entries: full.entries.slice(2),
    anchors: first,
  });
  const tool = next.find((row) => row.kind === "toolCall");
  assert.equal(tool?.turnId, "turn:u0");
  assert.deepEqual(tool?.kind === "toolCall" && tool.input, { path: "file" });
  assert.equal(tool?.rowId, first.find((row) => row.kind === "toolCall")?.rowId);
  assert.throws(
    () => projectHistory({ sessionId: "s1", turns: full.turns, entries: full.entries.slice(2) }),
    /HISTORY_ANCHOR_REQUIRED/,
  );
});

test("HS4: page reads capture owner watermark and cannot overwrite newer streamed tool bytes", async () => {
  const h = harness({ entries: users(2) });
  try {
    const initial = await h.adapter.readNekSession(params);
    const response = await h.adapter.conversationHistoryPageV4(params);
    assert.equal(response.atSeq, initial.seq);
    assert.equal(response.atLogEpoch, initial.logEpoch);
    h.sessions[0]!.emit({
      type: "message_start",
      message: { role: "user", timestamp: 77, content: "live" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const binding = await h.adapter.ensureNekSessionBinding(params, sessionId);
    const projector = h.adapter.service.commandContext().target(binding.sessionKey).projector!;
    projector.flushNow();
    const after = await h.adapter.conversationHistoryPageV4(params);
    assert.ok(after.atSeq > response.atSeq);
    assert.ok(
      projector
        .snapshot()
        .rows.window.some((row) => row.kind === "userInput" && row.text === "live"),
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("HS4: close during delayed bounded read rejects its stale result", async () => {
  const gate = Promise.withResolvers<void>();
  const entries = users(2);
  let hold = false;
  const h = harness({
    entries,
    historyOverride: (command) =>
      command.type === "read_history_page" && hold
        ? gate.promise.then(() =>
            fixtureHistory(entries, command, {
              ...historySummary,
              id: sessionId,
              path: sessionPath,
            }),
          )
        : undefined,
  });
  try {
    await h.adapter.readNekSession(params);
    hold = true;
    const pending = h.adapter.conversationHistoryPageV4(params);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.adapter.closeNekSession(params);
    gate.resolve();
    await assert.rejects(pending);
  } finally {
    gate.resolve();
    await h.adapter.dispose();
  }
});

test("HS5: capability gate fails visibly for local and remote targets", () => {
  assert.throws(
    () => requireHistoryPages({ capabilities: { promptAttachments: 1 } }),
    /historyPages=1.*Remote SSH/,
  );
  assert.doesNotThrow(() => requireHistoryPages({ capabilities: { historyPages: 1 } }));
});

test("HS6/HS7: actual response bytes and giant live frames fail explicitly without truncated success", () => {
  assert.throws(() => boundHistoryResult({ data: "中".repeat(1_500_000) }), /4 MB/);
  const source = page(users(1));
  const projector = new NekConversationProjector({ sessionId: "s1" });
  try {
    projector.loadHistory({ page: source, metadata: metadata(users(1)) });
    projector.handleEvent({
      type: "message_start",
      message: { role: "user", timestamp: 9, content: "x".repeat(2_000_000) },
    });
    const snapshot = projector.snapshot();
    assert.match(snapshot.control.lastError?.message ?? "", /bounded live content refs/);
    assert.ok(JSON.stringify(snapshot).length < 10_000);
  } finally {
    projector.dispose();
  }
});
