import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryPage,
  NekHistorySubagent,
  NekHistoryResult,
  NekSessionEntry,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { historyChildRowId } from "../src/nek-agent/projection/nekHistoryIdentity.js";
import { projectHistory } from "../src/nek-agent/projection/nekHistoryProjection.js";
import { prepareHistoryPage } from "../src/nek-agent/service/nekHistoryAnchors.js";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import { entry, harness, params, sessionPath } from "./nekSessionHarness.js";

const child: NekSubagentRecord = {
  id: "old-worker",
  type: "explorer",
  description: "inspect",
  background: true,
  startedAt: 3,
  status: "running",
};
const user = (id: string): NekSessionEntry => ({
  ...entry,
  id,
  message: { role: "user", timestamp: 1, content: id },
});
const call = (id: string, name: string): NekSessionEntry => ({
  ...entry,
  id,
  message: {
    role: "assistant",
    timestamp: 2,
    provider: "test",
    model: "test",
    api: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: {} }],
  },
});
const result = (
  id: string,
  toolCallId: string,
  toolName: string,
  record: NekSubagentRecord,
): NekSessionEntry => ({
  ...entry,
  id,
  message: {
    role: "toolResult",
    timestamp: 4,
    toolCallId,
    toolName,
    isError: false,
    content: [],
    details: toolName === "await" ? { subagents: [record] } : { subagent: record },
  },
});
// 26 turns; the latest page references the same child repeatedly without its original spawn.
function transcript(delayed = false) {
  const entries = [
    user("owner"),
    call("spawn", "subagent"),
    ...(delayed ? [user("interleave")] : []),
    result("original", "spawn", "subagent", child),
    ...Array.from({ length: 25 }, (_, i) => user(`later-${i}`)),
  ];
  for (const [i, tool] of ["await", "subagent", "stop_subagent"].entries())
    entries.push(
      call(`call${i}`, tool),
      result(`result${i}`, `call${i}`, tool, { ...child, status: "completed", endedAt: 5 }),
    );
  return entries.map((e, i) => ({ ...e, parentId: i ? entries[i - 1]!.id : null }));
}
function assertChild(rows: readonly ConversationRow[], spawnPosition: number) {
  const children = rows.filter((row) => row.kind === "subagent");
  assert.equal(children.length, 1);
  assert.deepEqual(
    [children[0]!.rowId, children[0]!.turnId, children[0]!.parentToolCallId, children[0]!.status],
    [historyChildRowId(spawnPosition), "turn:owner", "spawn", "success"],
  );
}
for (const locked of [false, true])
  test(`late child updates restore from a cold ${locked ? "read-only" : "writable"} tail without scanning history`, async () => {
    const entries = transcript();
    const h = harness({
      entries,
      ...(locked
        ? { lockedBy: { pid: 42, kind: "rpc", hostname: "fixture", startedAt: entry.timestamp } }
        : {}),
    });
    try {
      const initial = await h.adapter.readNekSession(params);
      assertChild(initial.rows.window, 2);
      assert.equal(initial.history?.turns.length, 20);
      const commands = locked ? h.control.commands : h.sessions[0]!.commands;
      const reads = commands.filter((c) => c.type === "read_history_page" && c.view === "target");
      assert.equal(reads.length, 1);
      assert.ok(reads[0]?.type === "read_history_page");
      assert.equal(reads[0].aroundEntryId, "original");
      assert.equal(reads[0].turnLimit, 1);
      assert.ok(reads[0].observationCursor);
      assert.equal(reads[0].sessionPath, locked ? sessionPath : undefined);
      const older = await h.adapter.conversationHistoryPageV4({
        ...params,
        aroundEntryId: "original",
        turnLimit: 1,
      });
      assertChild(older.rows, 2);
      assert.ok(
        !commands.some((c) => c.type === "get_entries" || c.type === "read_session_snapshot"),
      );
    } finally {
      await h.adapter.dispose();
    }
  });

test("a live await locator after cold restore admits the old spawn without moving it to the live turn", async () => {
  const entries = transcript();
  const [update, done] = entries.splice(-6);
  const h = harness({ entries });
  try {
    const initial = await h.adapter.readNekSession(params);
    assert.ok(!initial.rows.window.some((row) => row.kind === "subagent"));
    const key = h.adapter.resolveSessionKey(params, params.sessionId)!;
    const stream = h.sessions[0]!;
    entries.push(update!, done!);
    stream.append(update!.id);
    stream.append(done!.id);
    const deadline = Date.now() + 4000;
    for (;;) {
      const snapshot = h.adapter.service.conversationSnapshot(key);
      assert.equal(snapshot.control.lastError ?? null, null);
      if (snapshot.rows.window.some((row) => row.kind === "subagent")) {
        assertChild(snapshot.rows.window, 2);
        break;
      }
      assert.ok(Date.now() < deadline, "persisted locator was not projected");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      stream.commands.filter(
        (c) =>
          c.type === "read_history_page" && c.view === "target" && c.aroundEntryId === "original",
      ).length,
      1,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("child preview origin reads stay on the authorized child session", async () => {
  const owner = {
    ...child,
    id: "preview-child",
    sessionFile: "/children/preview.sqlite",
    status: "completed",
  } as const;
  const h = harness({
    entries: [
      user("parent"),
      call("start", "subagent"),
      result("preview", "start", "subagent", owner),
    ],
    childSnapshots: [
      {
        session: { ...historySummary, id: owner.id, path: owner.sessionFile },
        entries: transcript(),
        leafId: "result2",
        messages: [],
      },
    ],
  });
  try {
    const preview = await h.adapter.getSubagentConversation({ ...params, id: owner.id });
    assertChild(preview.rows, 2);
    const reads = h.sessions[0]!.commands.filter(
      (c) =>
        c.type === "read_history_page" && c.view === "target" && c.aroundEntryId === "original",
    );
    assert.equal(reads.length, 1);
    assert.ok(reads[0]?.type === "read_history_page");
    assert.equal(reads[0].sessionPath, owner.sessionFile);
    assert.equal(h.sessions.length, 1, "no extra writable child process");
  } finally {
    await h.adapter.dispose();
  }
});

test("a delayed result uses the original assistant call's turn; duplicate references need only one origin read", async () => {
  const entries = transcript(true);
  const p = fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage;
  const queried: string[] = [];
  const prepared = await prepareHistoryPage(p, async (c) => {
    assert.equal(c.observationCursor, p.observationCursor);
    if (c.type === "read_history_subagent")
      return fixtureHistory(entries, c) as NekHistoryResult<NekHistorySubagent>;
    queried.push(c.aroundEntryId);
    const target = fixtureHistory(entries, c) as NekHistoryResult<NekHistoryPage>;
    if (target.ok && c.aroundEntryId === "original")
      target.entries.find((e) => e.id === "original")!.toolCallOrigin = {
        entryId: "spawn",
        position: 1,
        name: "subagent",
        toolCallId: "spawn",
      };
    return target;
  });
  assert.deepEqual(queried, ["original", "spawn"]);
  assertChild(projectHistory(prepared), 3);
  assert.deepEqual(prepared.turns, p.turns);
});

for (const problem of ["wrong session", "wrong child", "wrong position", "stale cursor"])
  test(`reject ${problem} rather than inventing an anchor`, async () => {
    const entries = transcript();
    const p = fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage;
    await assert.rejects(
      prepareHistoryPage(p, async (c) => {
        if (c.type === "read_history_subagent")
          return fixtureHistory(entries, c) as NekHistoryResult<NekHistorySubagent>;
        if (problem === "stale cursor")
          return { ok: false, error: { code: "STALE_CURSOR", message: "observed prefix changed" } };
        const target = fixtureHistory(entries, c) as NekHistoryPage;
        if (problem === "wrong session") target.sessionId = historySummary.id + "-other";
        const original = target.entries.find((e) => e.id === "original")!;
        if (problem === "wrong child")
          original.entry = {
            ...result("original", "spawn", "subagent", { ...child, id: "foreign" }),
          };
        if (problem === "wrong position") original.position += 3;
        return { ...target, ok: true };
      }),
      {
        code:
          problem === "wrong session"
            ? "FOREIGN_CURSOR"
            : problem === "stale cursor"
              ? "STALE_CURSOR"
              : "INVALID_RESPONSE",
      },
    );
  });
