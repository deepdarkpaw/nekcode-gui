import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryMetadata,
  NekHistoryPage,
  NekSessionEntry,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { projectHistory } from "../src/nek-agent/projection/nekHistoryProjection.js";
import { projectNekStatusEvent } from "../src/nek-agent/adapter/nekAgentStatusChannel.js";
import { fixtureHistory } from "./nekHistoryFixture.js";

const child: NekSubagentRecord = {
  id: "child",
  type: "explorer",
  description: "inspect",
  background: true,
  status: "running",
  startedAt: 2,
};
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const stored = (id: string, parentId: string | null, message: unknown): NekSessionEntry =>
  ({
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-17T00:00:00Z",
    message,
  }) as NekSessionEntry;
const call = (id: string, parent: string, toolName: string, args: unknown = {}) =>
  stored(id, parent, {
    role: "assistant",
    timestamp: 2,
    provider: "test",
    model: "test",
    api: "test",
    usage,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name: toolName, arguments: args }],
  });
const result = (
  id: string,
  parent: string,
  toolCallId: string,
  toolName: string,
  details: unknown,
) =>
  stored(id, parent, {
    role: "toolResult",
    timestamp: 3,
    toolCallId,
    toolName,
    content: [],
    details,
    isError: false,
  });
const source = [
  stored("u", null, { role: "user", content: "spawn", timestamp: 1 }),
  call("spawn", "u", "subagent", { description: "inspect" }),
  result("spawn-result", "spawn", "spawn", "subagent", { subagent: child }),
];
const page = (entries: NekSessionEntry[], aroundEntryId?: string) =>
  fixtureHistory(entries, {
    type: "read_history_page",
    aroundEntryId,
    turnLimit: 1,
  }) as NekHistoryPage;
const project = (p: NekHistoryPage, anchors?: ReturnType<typeof projectHistory>) =>
  projectHistory({
    sessionId: "s1",
    turns: p.turns,
    entries: p.entries,
    anchors,
  });

for (const toolName of ["subagent", "await", "stop_subagent"])
  test(`SA4: paged ${toolName} keeps the first spawn entity key, parent and turn`, () => {
    const first = project(page(source));
    const original = first.find((row) => row.kind === "subagent")!;
    const done = { ...child, status: "completed", endedAt: 5 };
    const entries = [
      ...source,
      stored("u2", "spawn-result", { role: "user", content: "later", timestamp: 4 }),
      call(
        "update",
        "u2",
        toolName,
        toolName === "subagent" ? { resume: child.id } : { subagent_id: child.id },
      ),
      result(
        "update-result",
        "update",
        "update",
        toolName,
        toolName === "await" ? { subagents: [done], running: [] } : { subagent: done },
      ),
    ];
    for (const rows of [
      project(page(entries), first),
      projectHistory({
        sessionId: "s1",
        turns: (fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage).turns,
        entries: (fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage).entries,
      }),
    ]) {
      const updated = rows.find((row) => row.kind === "subagent")!;
      assert.equal(rows.filter((row) => row.kind === "subagent").length, 1);
      assert.equal(updated.rowId, original.rowId);
      assert.equal(updated.turnId, "turn:u");
      assert.equal(updated.parentToolCallId, "spawn");
      assert.equal(updated.status, "success");
    }
  });

test("SA1/SA4: unanchored progress remains a status fact, not a fabricated off-window timeline row", () => {
  const entries = [stored("later", null, { role: "user", content: "latest page", timestamp: 9 })];
  const projector = new NekConversationProjector({ sessionId: "s1" });
  try {
    projector.loadHistory({
      page: page(entries),
      metadata: fixtureHistory(entries, { type: "read_session_metadata" }) as NekHistoryMetadata,
    });
    const event = {
      type: "extension_event" as const,
      source: "nek",
      name: "nek.subagent",
      payload: child,
    };
    assert.ok(
      projectNekStatusEvent(event),
      "the existing status channel still delivers the live child",
    );
    projector.handleEvent(event);
    assert.equal(projector.snapshot().control.lastError ?? null, null);
    assert.equal(
      projector.rows.window.some((row) => row.kind === "subagent"),
      false,
    );
    const anchors = project(page(source));
    projector.rememberHistoryAnchors("s1", "original", anchors);
    projector.handleEvent({ ...event, payload: { ...child, status: "completed", endedAt: 10 } });
    const restored = projector.rows.window.find((row) => row.kind === "subagent")!;
    assert.equal(restored.turnId, "turn:u");
    assert.equal(restored.parentToolCallId, "spawn");
    assert.equal(restored.rowId, anchors.find((row) => row.kind === "subagent")!.rowId);
    assert.equal(restored.status, "success");
  } finally {
    projector.dispose();
  }
});

test("SA2/SA5: cold history still settles persisted running children; real missing tool seeds still fail", () => {
  assert.equal(project(page(source)).find((row) => row.kind === "subagent")?.status, "cancelled");
  const projector = new NekConversationProjector({ sessionId: "s1" });
  try {
    const entries = [source[0]!, call("resume", "u", "subagent", { resume: child.id })];
    projector.loadHistory({
      page: page(entries),
      metadata: fixtureHistory(entries, { type: "read_session_metadata" }) as NekHistoryMetadata,
    });
    projector.applySubagent(child, "resume");
    assert.match(projector.snapshot().control.lastError?.message ?? "", /HISTORY_ANCHOR_REQUIRED/);
    assert.equal(
      projector.rows.window.some((row) => row.kind === "subagent"),
      false,
    );
  } finally {
    projector.dispose();
  }
});
