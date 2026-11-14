import assert from "node:assert/strict";
import test from "node:test";
import type { NekHistoryPage, NekSessionEntry } from "@zcode/shared/nek-protocol";
import { NekHistoryAnchorCache } from "../src/nek-agent/projection/nekHistoryAnchorCache.js";
import { buildToolCallRow } from "../src/nek-agent/projection/nekRows.js";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import { entry, harness, params, sessionId, sessionPath } from "./nekSessionHarness.js";

test("HS6: seed cache retains six pages at most and never caches completed output bodies", () => {
  const cache = new NekHistoryAnchorCache();
  for (let index = 0; index < 7; index++)
    cache.remember(String(index), String(index), [
      buildToolCallRow(
        { rowId: index + 1, entityId: `tool:${index}`, turnId: "t", createdAt: 1 },
        {
          toolCallId: String(index),
          toolName: "read",
          status: "success",
          input: { path: "file" },
          output: { text: "large body".repeat(100) },
        },
      ),
    ]);
  assert.equal(cache.read("0").length, 0);
  const retained = cache.read("6")[0];
  assert.equal(retained?.kind === "toolCall" && retained.output, undefined);
  cache.clear();
  assert.equal(cache.read("6").length, 0);
});

test("HS3/HS6: an old target's continuation uses admitted bounded tool seeds, never fetches its missing prefix", async () => {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const call: NekSessionEntry = {
    ...entry,
    id: "old-call",
    parentId: entry.id,
    message: {
      role: "assistant",
      timestamp: 2,
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "old-tool", name: "read", arguments: { path: "original" } },
      ],
    },
  };
  const result: NekSessionEntry = {
    ...entry,
    id: "old-result",
    parentId: call.id,
    message: {
      role: "toolResult",
      timestamp: 3,
      toolCallId: "old-tool",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
    },
  };
  const entries: NekSessionEntry[] = [
    entry,
    call,
    result,
    ...Array.from(
      { length: 69 },
      (_, i): NekSessionEntry => ({
        ...entry,
        id: `later-${i}`,
        parentId: i ? `later-${i - 1}` : result.id,
        message: { role: "user", content: "later", timestamp: i + 4 },
      }),
    ),
  ];
  const selected = fixtureHistory(
    entries,
    { type: "read_history_page", aroundEntryId: entry.id, turnLimit: 1 },
    { ...historySummary, id: sessionId, path: sessionPath },
  ) as NekHistoryPage;
  const h = harness({
    entries,
    historyOverride: (command) => {
      if (command.type === "read_history_page" && command.aroundEntryId)
        return {
          ...selected,
          entries: selected.entries.slice(0, 2),
          turns: [{ ...selected.turns[0]!, continuationCursor: "within" }],
        };
      if (command.type === "read_history_turn")
        return {
          ...selected,
          turn: selected.turns[0],
          entries: selected.entries.slice(2),
          hasMore: false,
        };
      return undefined;
    },
  });
  try {
    await h.adapter.readNekSession(params);
    const old = await h.adapter.conversationHistoryPageV4({ ...params, aroundEntryId: entry.id });
    assert.equal(old.history.turns[0]?.continuationCursor, "within");
    const tool = old.rows.find((row) => row.kind === "toolCall");
    assert.equal(tool?.kind === "toolCall" && tool.status, "inputStreaming");
    const before = h.sessions[0]!.commands.length;
    const continued = await h.adapter.conversationHistoryTurnV4({
      ...params,
      turnId: `turn:${entry.id}`,
      cursor: "within",
    });
    const next = continued.rows.find((row) => row.kind === "toolCall");
    assert.equal(next?.rowId, tool?.rowId);
    assert.deepEqual(next?.kind === "toolCall" && next.input, { path: "original" });
    assert.equal(next?.kind === "toolCall" && next.output?.text, "result");
    assert.deepEqual(
      h.sessions[0]!.commands.slice(before).map((command) => command.type),
      ["read_history_turn"],
    );
  } finally {
    await h.adapter.dispose();
  }
});
