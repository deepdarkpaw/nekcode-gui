import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekHistoryIdentity,
  NekHistoryPage,
  NekRpcCommand,
  NekSessionEntry,
  NekSessionSnapshot,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import { fixtureHistory, historySummary } from "./nekHistoryFixture.js";
import { entry, harness, params, sessionId, sessionPath } from "./nekSessionHarness.js";

function users(count: number): NekSessionEntry[] {
  return Array.from({ length: count }, (_, n) => ({
    ...entry,
    id: `user-${n}`,
    parentId: n ? `user-${n - 1}` : null,
    message: { role: "user", content: `question ${n}`, timestamp: n + 1 },
  }));
}
const summary = { ...historySummary, id: sessionId, path: sessionPath };

test("HO5: normal adapter reads forward guarded prefix proof, accept append and retain captured owner watermark", async () => {
  const original = users(3);
  let appended = false;
  const h = harness({
    entries: original,
    historyOverride: (command) => {
      if (command.type !== "read_history_page") return undefined;
      if (command.observationCursor && command.observationCursor !== `observation:${sessionId}:3`)
        return { ok: false, error: { code: "STALE_CURSOR", message: "observed prefix changed" } };
      return fixtureHistory(appended ? users(4) : original, command, summary);
    },
  });
  try {
    const snapshot = await h.adapter.readNekSession(params);
    assert.equal(
      snapshot.history?.observationCursor,
      `observation:${sessionId}:3`,
      "the initial projected window must carry the source proof for the first guarded older read",
    );
    const metadata = h.sessions[0]!.commands.find(
      (command) => command.type === "read_session_metadata",
    );
    assert.equal(metadata?.observationCursor, `observation:${sessionId}:3`);
    assert.equal(
      metadata?.branchRevision,
      undefined,
      "snapshot read chains must not retain an exact hash guard across append",
    );
    const first = await h.adapter.conversationHistoryPageV4({ ...params, turnLimit: 1 });
    appended = true;
    const second = await h.adapter.conversationHistoryPageV4({
      ...params,
      aroundEntryId: "user-0",
      turnLimit: 1,
      observationCursor: first.history.observationCursor,
    });
    assert.notEqual(second.history.branchRevision, first.history.branchRevision);
    assert.equal(second.history.observationCursor, `observation:${sessionId}:4`);
    assert.equal(second.atLogEpoch, snapshot.logEpoch);
    assert.equal(second.atSeq, snapshot.seq);
    assert.equal(second.atRevision, snapshot.revision);
    assert.ok(
      h.sessions[0]!.commands.some(
        (command) =>
          command.type === "read_history_page" &&
          command.aroundEntryId === "user-0" &&
          command.observationCursor === first.history.observationCursor,
      ),
    );
    await assert.rejects(
      h.adapter.conversationHistoryPageV4({ ...params, aroundEntryId: "user-0", turnLimit: 1 }),
      /history branch changed/,
    );
    await assert.rejects(
      h.adapter.conversationHistoryPageV4({
        ...params,
        aroundEntryId: "user-0",
        turnLimit: 1,
        observationCursor: "foreign",
      }),
      /observed prefix changed/,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("HO3/HO5: child preview and all explicit reads guard the child source, not the authorizing parent", async () => {
  const child: NekSubagentRecord = {
    id: "child",
    type: "worker",
    description: "child",
    background: false,
    status: "completed",
    startedAt: 1,
    sessionFile: "/children/child.jsonl",
  };
  const childSnapshot: NekSessionSnapshot = {
    session: { ...historySummary, id: child.id, path: child.sessionFile! },
    entries: users(1),
    messages: [],
    leafId: "user-0",
  };
  let stale = false;
  const childCommands: NekRpcCommand[] = [];
  const h = harness({
    subagents: [child],
    childSnapshots: [childSnapshot],
    historyOverride: (command) => {
      if (command.type === "read_history_subagent" && command.subagentId === child.id)
        assert.equal(
          command.observationCursor,
          undefined,
          "child observation must not be applied to parent membership",
        );
      if (!("sessionPath" in command) || command.sessionPath !== child.sessionFile)
        return undefined;
      if (
        !(
          command.type === "read_history_page" ||
          command.type === "read_history_turn" ||
          command.type === "read_history_directory" ||
          command.type === "read_history_content"
        )
      )
        return undefined;
      childCommands.push(command);
      if (
        command.observationCursor &&
        (stale ||
          !["observation:child:1", "observation:child:2"].includes(command.observationCursor))
      )
        return {
          ok: false,
          error: { code: "STALE_CURSOR", message: "child observed prefix changed" },
        };
      const page = fixtureHistory(
        childSnapshot.entries,
        { type: "read_history_page" },
        childSnapshot.session,
      ) as NekHistoryPage;
      const identity: NekHistoryIdentity = {
        sessionId: page.sessionId,
        sessionPath: page.sessionPath,
        branchRevision: page.branchRevision,
        observationCursor: page.observationCursor,
        leafId: page.leafId,
        watermark: page.watermark,
      };
      if (command.type === "read_history_page")
        return fixtureHistory(childSnapshot.entries, command, childSnapshot.session);
      if (command.type === "read_history_turn")
        return {
          ok: true,
          ...identity,
          turn: page.turns[0],
          entries: page.entries.slice(0, 1),
          hasMore: false,
        };
      if (command.type === "read_history_directory")
        return {
          ok: true,
          ...identity,
          items: [{ entryId: "user-0", turnId: "turn:user-0", position: 0, preview: "question" }],
          totalTurns: page.totalTurns,
          hasMore: false,
        };
      return {
        ok: true,
        ...identity,
        ref: command.ref,
        offset: command.offset ?? 0,
        totalBytes: 1,
        encoding: "base64",
        mediaType: "application/json",
        data: "YQ==",
      };
    },
  });
  try {
    const first = await h.adapter.getSubagentConversation({
      ...params,
      id: child.id,
      turnLimit: 20,
    });
    childSnapshot.entries.push(users(2)[1]!);
    const second = await h.adapter.getSubagentConversation({
      ...params,
      id: child.id,
      turnLimit: 20,
      observationCursor: first.history.observationCursor,
    });
    assert.notEqual(second.history.branchRevision, first.history.branchRevision);
    assert.equal(second.history.observationCursor, "observation:child:2");
    const target = {
      ...params,
      subagentId: child.id,
      observationCursor: first.history.observationCursor,
    };
    const turn = await h.adapter.conversationHistoryTurnV4({ ...target, turnId: "turn:user-0" });
    const directory = await h.adapter.conversationHistoryDirectoryV4({ ...target, limit: 1 });
    const content = await h.adapter.conversationHistoryContentV4({
      ...target,
      ref: "opaque",
      offset: 0,
      limit: 1,
    });
    for (const result of [turn, directory, content]) {
      assert.equal(result.observationCursor, second.history.observationCursor);
      assert.equal(result.branchRevision, second.history.branchRevision);
    }
    assert.ok(
      childCommands.filter(
        (command) =>
          "observationCursor" in command &&
          command.observationCursor === first.history.observationCursor,
      ).length >= 4,
    );
    assert.equal(h.sessions.length, 1, "child reads must never open a second runtime");
    stale = true;
    await assert.rejects(
      h.adapter.getSubagentConversation({
        ...params,
        id: child.id,
        observationCursor: second.history.observationCursor,
      }),
      /child observed prefix changed/,
    );
    const count = childCommands.length;
    await assert.rejects(
      h.adapter.getSubagentConversation({
        ...params,
        id: "foreign-child",
        observationCursor: second.history.observationCursor,
      }),
      /Unknown subagent/,
    );
    assert.equal(childCommands.length, count);
  } finally {
    await h.adapter.dispose();
  }
});

test("HO5: valid observation never bypasses source page-cursor validation or starts a fallback read", async () => {
  const h = harness({
    historyOverride: (command) =>
      command.type === "read_history_page" && command.beforeCursor === "opaque-invalid"
        ? { ok: false, error: { code: "INVALID_CURSOR", message: "invalid source page cursor" } }
        : undefined,
  });
  try {
    await h.adapter.readNekSession(params);
    const before = h.sessions[0]!.commands.filter(
      (command) => command.type === "read_history_page",
    ).length;
    await assert.rejects(
      h.adapter.conversationHistoryPageV4({
        ...params,
        beforeCursor: "opaque-invalid",
        observationCursor: `observation:${sessionId}:1`,
      }),
      { code: "INVALID_CURSOR" },
    );
    const reads = h.sessions[0]!.commands.filter((command) => command.type === "read_history_page");
    assert.equal(reads.length, before + 1);
    assert.equal(reads.at(-1)?.observationCursor, `observation:${sessionId}:1`);
  } finally {
    await h.adapter.dispose();
  }
});

test("HO4: missing mandatory source observation is rejected before projection, never accepted as empty history", async () => {
  const h = harness({
    historyOverride: (command) => {
      if (command.type !== "read_history_page" || !command.beforeCursor) return undefined;
      const page = fixtureHistory([entry], command, summary) as NekHistoryPage;
      return { ...page, observationCursor: undefined };
    },
  });
  try {
    await h.adapter.readNekSession(params);
    await assert.rejects(
      h.adapter.conversationHistoryPageV4({
        ...params,
        beforeCursor: "1",
        observationCursor: `observation:${sessionId}:1`,
      }),
      /omitted observationCursor/,
    );
  } finally {
    await h.adapter.dispose();
  }
});
