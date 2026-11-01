import assert from "node:assert/strict";
import test from "node:test";
import type { NekSessionEntry, NekSessionSnapshot } from "@zcode/shared/nek-protocol";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";
import { createProcess, entry, guiInfo, target } from "./nekSessionHarness.js";

function forkHarness(outcome: "success" | "cancel" | "error" = "success") {
  const entries: NekSessionEntry[] = [
    entry,
    {
      ...entry,
      id: "user-2",
      parentId: entry.id,
      message: { role: "user", content: "edit this prompt", timestamp: 2 },
    },
  ];
  const snapshots = new Map<string, NekSessionSnapshot>();
  const source = "/sessions/source.sqlite";
  const child = "/sessions/child.sqlite";
  const snapshot = (id: string, path: string, history: NekSessionEntry[]): NekSessionSnapshot => ({
    session: {
      id,
      path,
      cwd: target.workspacePath,
      createdAt: entry.timestamp,
      modifiedAt: entry.timestamp,
      messageCount: history.length,
      firstMessage: "saved prompt",
      locked: false,
    },
    entries: history,
    messages: history.flatMap((item) => (item.type === "message" ? [item.message] : [])),
    leafId: history.at(-1)?.id ?? null,
  });
  snapshots.set(source, snapshot("source", source, entries));
  const control = createProcess((command) => {
    if (command.type === "read_session_snapshot") return snapshots.get(command.sessionPath);
    if (command.type === "list_sessions")
      return { sessions: [...snapshots.values()].map((item) => item.session) };
    if (command.type === "get_project_trust")
      return {
        cwd: target.workspacePath,
        trusted: true,
        defaultProjectTrust: "always",
        resources: [],
      };
    return {};
  });
  const processes: ReturnType<typeof createProcess>[] = [];
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      let active = request.sessionPath!;
      const process = createProcess((command) => {
        const current = snapshots.get(active)!;
        if (command.type === "get_state")
          return {
            sessionId: current.session.id,
            sessionFile: active,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: true,
            messageCount: current.messages.length,
            pendingMessageCount: 0,
          };
        if (command.type === "get_entries")
          return { entries: current.entries, leafId: current.leafId };
        if (command.type === "get_session_stats")
          return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
        if (command.type === "extension_call")
          return { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
        if (command.type === "fork") {
          assert.equal(command.entryId, "user-2");
          if (outcome === "error") throw new Error("extension refused fork");
          if (outcome === "cancel") return { cancelled: true };
          snapshots.set(child, snapshot("child", child, [entry]));
          active = child;
          return { cancelled: false, text: "edit this prompt" };
        }
        return {};
      });
      processes.push(process);
      return process.process;
    },
  });
  return { adapter, processes, snapshots, source };
}

async function forkCommand(h: ReturnType<typeof forkHarness>) {
  const snapshot = await h.adapter.readNekSession({ ...target, sessionId: "source" });
  const row = snapshot.rows.window.find(
    (item) => item.kind === "userInput" && item.text === "edit this prompt",
  )!;
  return {
    commandId: "fork-1",
    clientId: "test",
    type: "forkUserMessage",
    sessionId: "source",
    issuedAt: 1,
    baseRevision: snapshot.revision,
    baseLogEpoch: snapshot.logEpoch,
    payload: { target: { rowId: row.rowId, entityId: row.entityId } },
  };
}

test("fork mapping passes the exact user entry, opens the actual fork and returns unsent editor text", async () => {
  const h = forkHarness();
  try {
    const envelope = await forkCommand(h);
    const ack = await h.adapter.sendNekConversationCommandV4({ target, envelope });
    assert.equal(ack.status, "accepted");
    assert.deepEqual(ack.result, {
      type: "forkUserMessage",
      sessionId: "child",
      text: "edit this prompt",
    });
    const child = await h.adapter.readNekSession({ ...target, sessionId: "child" });
    assert.deepEqual(
      child.rows.window.filter((row) => row.kind === "userInput").map((row) => row.text),
      ["saved prompt"],
    );
    assert.equal(
      h.processes[0]?.isDisposed(),
      true,
      "source-keyed process cannot remain attached to the fork",
    );
    const source = await h.adapter.readNekSession({ ...target, sessionId: "source" });
    assert.equal(source.rows.window.filter((row) => row.kind === "userInput").length, 2);
    assert.equal(
      h.processes.flatMap((p) => p.commands).some((command) => command.type === "prompt"),
      false,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("fork mapping rejects stale epoch/revision and non-user or mismatched row targets without RPC", async () => {
  const h = forkHarness();
  try {
    const envelope = await forkCommand(h);
    for (const changed of [
      { baseRevision: -1 },
      { baseLogEpoch: "old" },
      { payload: { target: { rowId: 1, entityId: "entry:user-2:user" } } },
      { payload: { target: { rowId: 4, entityId: "assistant" } } },
    ]) {
      const ack = await h.adapter.sendNekConversationCommandV4({
        target,
        envelope: { ...envelope, ...changed },
      });
      assert.equal(ack.status, "stale");
    }
    assert.equal(
      h.processes[0]?.commands.some((command) => command.type === "fork"),
      false,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("fork cancellation leaves the source open; RPC failure reaches the command caller", async () => {
  for (const outcome of ["cancel", "error"] as const) {
    const h = forkHarness(outcome);
    try {
      const envelope = await forkCommand(h);
      const call = h.adapter.sendNekConversationCommandV4({ target, envelope });
      if (outcome === "error") await assert.rejects(call, /extension refused fork/u);
      else assert.equal((await call).reasonCode, "guard.forkCancelled");
      assert.equal(h.processes.length, 1);
      assert.equal(h.processes[0]?.isDisposed(), false);
    } finally {
      await h.adapter.dispose();
    }
  }
});
