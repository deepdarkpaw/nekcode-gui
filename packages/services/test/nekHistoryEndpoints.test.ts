import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekSessionEntry,
  NekSessionSnapshot,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import { entry, harness, params, sessionId, sessionPath } from "./nekSessionHarness.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const child: NekSubagentRecord = {
  id: "old-child",
  type: "worker",
  description: "old worker",
  background: true,
  status: "completed",
  startedAt: 1,
  sessionFile: "/children/old-child.jsonl",
};
function parentEntries(): NekSessionEntry[] {
  const call: NekSessionEntry = {
    ...entry,
    id: "spawn",
    parentId: entry.id,
    message: {
      role: "assistant",
      timestamp: 2,
      api: "test",
      provider: "test",
      model: "test",
      usage,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "spawn-call", name: "subagent", arguments: {} }],
    },
  };
  const result: NekSessionEntry = {
    ...entry,
    id: "spawn-result",
    parentId: call.id,
    message: {
      role: "toolResult",
      timestamp: 3,
      toolCallId: "spawn-call",
      toolName: "subagent",
      content: [{ type: "text", text: "done" }],
      details: { subagent: child },
      isError: false,
    },
  };
  return [
    entry,
    call,
    result,
    ...Array.from(
      { length: 69 },
      (_, i): NekSessionEntry => ({
        ...entry,
        id: `later-${i}`,
        parentId: i ? `later-${i - 1}` : result.id,
        message: { role: "user", content: `round ${i}`, timestamp: i + 4 },
      }),
    ),
  ];
}
const childSnapshot: NekSessionSnapshot = {
  session: { ...historySummary, id: child.id, path: child.sessionFile! },
  entries: [
    { ...entry, id: "child-user", message: { role: "user", content: "child input", timestamp: 1 } },
  ],
  messages: [],
  leafId: "child-user",
};

test("HS5: old child outside20 is authorized in parent before bounded child read, without resume or parent body traversal", async () => {
  const h = harness({ entries: parentEntries(), childSnapshots: [childSnapshot] });
  try {
    const status = await h.adapter.getNekStatusSnapshot(params);
    assert.equal(status.historyChildren?.total, 1);
    assert.equal(status.historyChildren?.loaded, 1);
    assert.equal(status.historyChildren?.complete, true);
    assert.equal(status.historyChildren?.items?.[0]?.id, child.id);
    const preview = await h.adapter.getSubagentConversation({ ...params, id: child.id });
    assert.equal(preview.history.turns.length, 1);
    assert.equal(preview.status, "completed");
    const commands = h.sessions[0]!.commands;
    const membership = commands.findIndex(
      (command) => command.type === "read_history_subagent" && command.subagentId === child.id,
    );
    const content = commands.findIndex(
      (command) =>
        command.type === "read_history_page" && command.sessionPath === child.sessionFile,
    );
    assert.ok(membership >= 0 && content > membership);
    assert.equal(h.sessions.length, 1);
    assert.equal(
      commands.some(
        (command) => command.type === "get_entries" || command.type === "read_session_snapshot",
      ),
      false,
    );
    assert.equal(
      commands.some(
        (command) =>
          command.type === "extension_call" && command.method === "nek.get_subagent_transcript",
      ),
      false,
    );
    const count = commands.filter(
      (command) =>
        command.type === "read_history_page" && command.sessionPath === child.sessionFile,
    ).length;
    await assert.rejects(
      h.adapter.getSubagentConversation({ ...params, id: "foreign-child" }),
      /Unknown subagent/,
    );
    assert.equal(
      commands.filter(
        (command) =>
          command.type === "read_history_page" && command.sessionPath === child.sessionFile,
      ).length,
      count,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("HS5: locked parent authorizes old child with the same bounded control path", async () => {
  const h = harness({
    entries: parentEntries(),
    childSnapshots: [childSnapshot],
    lockedBy: { pid: 1, hostname: "other", kind: "rpc", startedAt: entry.timestamp },
  });
  try {
    const result = await h.adapter.getSubagentConversation({ ...params, id: child.id });
    assert.equal(result.history.turns.length, 1);
    assert.equal(h.sessions.length, 0);
    assert.ok(h.control.commands.some((command) => command.type === "read_history_subagent"));
    assert.ok(
      h.control.commands.some(
        (command) =>
          command.type === "read_history_page" && command.sessionPath === child.sessionFile,
      ),
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("HS2/HS4: directory method forwards fixed bounded fields and returns owner watermark", async () => {
  const identity = fixtureHistory(
    [],
    { type: "read_session_metadata" },
    { ...historySummary, id: sessionId, path: sessionPath },
  ) as object;
  const h = harness({
    historyOverride: (command) => {
      if (command.type === "read_history_directory")
        return {
          ...identity,
          items: [
            { entryId: entry.id, turnId: `turn:${entry.id}`, position: 0, preview: "saved prompt" },
          ],
          totalTurns: 1,
          hasMore: false,
        };
      return undefined;
    },
  });
  try {
    const snapshot = await h.adapter.readNekSession(params);
    const directory = await h.adapter.conversationHistoryDirectoryV4({
      ...params,
      query: "saved",
      limit: 1,
    });
    assert.equal(directory.atLogEpoch, snapshot.logEpoch);
    assert.equal(directory.items[0]?.entryId, entry.id);
    const command = h.sessions[0]!.commands.find(
      (command) => command.type === "read_history_directory",
    );
    assert.equal(command?.maxBytes, 1024 * 1024);
  } finally {
    await h.adapter.dispose();
  }
});
