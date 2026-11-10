import assert from "node:assert/strict";
import test from "node:test";
import type { NekSessionEntry, NekState, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import { createProcess } from "./nekSessionHarness.js";
import {
  getStatusSnapshot,
  stopSubagent,
  type NekAgentCommandTarget,
} from "../src/nek-agent/service/nekAgentServiceCommands.js";
import { projectEntries } from "../src/nek-agent/projection/nekEntryProjection.js";

const child: NekSubagentRecord = {
  id: "old-child",
  type: "worker",
  description: "Old worker",
  background: true,
  status: "running",
  startedAt: 1000,
};
const entry: NekSessionEntry = {
  id: "spawn-result",
  parentId: null,
  type: "message",
  timestamp: new Date(1100).toISOString(),
  message: {
    role: "toolResult",
    toolName: "subagent",
    toolCallId: "spawn",
    timestamp: 1100,
    content: [{ type: "text", text: "started" }],
    details: { subagent: child },
    isError: false,
  },
};
const state = (subagents: NekSubagentRecord[]): NekState => ({
  mode: "agent",
  todos: [],
  plans: [],
  subagents,
});
const runtime = (running: boolean) => ({
  sessionId: "parent",
  thinkingLevel: "medium",
  isStreaming: running,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: false,
  messageCount: 2,
  pendingMessageCount: 0,
});

function fixture(running: boolean, live: NekSubagentRecord[], beforeEntries = async () => {}) {
  const events: string[] = [];
  const p = createProcess(async (command) => {
    events.push(command.type === "extension_call" ? command.method : command.type);
    if (command.type === "get_state") return runtime(running);
    if (command.type === "get_session_stats") return {};
    if (command.type === "get_entries") {
      await beforeEntries();
      events.push("entries-read");
      return { entries: [entry], leafId: entry.id };
    }
    if (command.type === "extension_call" && command.method === "nek.get_state")
      return { result: state(live) };
    if (command.type === "extension_call" && command.method === "nek.stop_subagent")
      throw new Error(`Unknown subagent ${(command.params as { id: string }).id}.`);
    throw new Error(`unexpected command ${command.type}`);
  });
  const target: NekAgentCommandTarget = {
    client: p.process.client,
    phase: "running",
    setPhase: () => {},
  };
  const context = {
    target: () => target,
    writableTarget: () => target,
    control: async () => p.process.client,
  };
  return { p, context, events };
}

for (const running of [false, true]) {
  test(`SS-1: parent running=${running} cannot make a historical child missing from the registry stoppable`, async () => {
    const { p, context } = fixture(running, []);
    try {
      const snapshot = await getStatusSnapshot(context, "parent");
      assert.equal(snapshot.running, running);
      assert.equal(snapshot.state.subagents[0]?.status, "aborted");
      assert.equal(snapshot.state.subagents[0]?.id, child.id);
    } finally {
      await p.process.dispose();
    }
  });
}

test("SS-1/SS-3: idle parent still has a running child when the registry says so; live facts beat history", async () => {
  const live = { ...child, activity: "Still working" };
  const { p, context } = fixture(false, [live]);
  try {
    const snapshot = await getStatusSnapshot(context, "parent");
    assert.equal(snapshot.state.subagents.length, 1);
    assert.deepEqual(snapshot.state.subagents[0], live);
  } finally {
    await p.process.dispose();
  }
});

test("SS-2: registry is sampled after entries, so a newly spawned child is never falsely aborted", async () => {
  const gate = Promise.withResolvers<void>();
  const live: NekSubagentRecord[] = [];
  const { p, context, events } = fixture(true, live, () => gate.promise);
  const pending = getStatusSnapshot(context, "parent");
  try {
    await new Promise<void>((ok) => setTimeout(ok, 5));
    assert.ok(events.includes("get_entries"));
    assert.ok(!events.includes("nek.get_state"), "registry must not be older than entries");
    live.push(child);
    gate.resolve();
    const snapshot = await pending;
    assert.ok(events.indexOf("entries-read") < events.indexOf("nek.get_state"));
    assert.equal(snapshot.state.subagents[0]?.status, "running");
  } finally {
    gate.resolve();
    await pending.catch(() => {});
    await p.process.dispose();
  }
});

for (const status of ["running", "completed", "errored", "aborted"] as const) {
  test(`SS-3: conversation replay uses registry ${status} instead of parent liveness`, () => {
    const live = { ...child, status };
    const projection = projectEntries({
      sessionId: "parent",
      entries: [entry],
      state: runtime(true),
      nekState: state([live]),
    });
    const row = projection.rows.find((row) => row.kind === "subagent");
    const expected = {
      running: "running",
      completed: "success",
      errored: "failed",
      aborted: "cancelled",
    };
    assert.equal(row?.kind === "subagent" && row.status, expected[status]);
    assert.equal(row?.kind === "subagent" && row.parentToolCallId, "spawn");
  });
}

test("SS-3: conversation replay does not revive an absent historical child while parent is running", () => {
  const projection = projectEntries({
    sessionId: "parent",
    entries: [entry],
    state: runtime(true),
    nekState: state([]),
  });
  const row = projection.rows.find((row) => row.kind === "subagent");
  assert.equal(row?.kind === "subagent" && row.status, "cancelled");
});

test("SS-4: stopping an unknown child still fails visibly, never returns a fabricated aborted ACK", async () => {
  const { p, context } = fixture(true, []);
  try {
    await assert.rejects(
      stopSubagent(context, { sessionKey: "parent", id: child.id }),
      /nek extension_call failed: Unknown subagent old-child\./,
    );
  } finally {
    await p.process.dispose();
  }
});
