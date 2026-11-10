import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekAgentMessage,
  NekAssistantMessage,
  NekSessionEntry,
  NekSessionSnapshot,
  NekSubagentRecord,
  NekToolResultMessage,
} from "@zcode/shared/nek-protocol";
import {
  conversationRowSchema,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type SubagentRow,
} from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { projectEntries } from "../src/nek-agent/projection/nekEntryProjection.js";
import {
  collectPersistedSubagentRecords,
  extractSubagentsFromToolResult,
  isNekSubagentRecord,
} from "../src/nek-agent/projection/nekSubagentRecords.js";
import { harness, params } from "./nekSessionHarness.js";

/**
 * 重开 GUI 后的子代理复原。
 *
 * nek 的 subagent registry 是纯内存表：重启后 `nek.get_state` 的 `subagents` 恒为空，
 * 子代理的唯一持久化事实是 `subagent` / `await` / `stop_subagent` 三个工具的 toolResult
 * `details`。时间线投影、状态槽快照与右侧预览都必须从 entries 还原同一批记录。
 */

const CHILD_IDS = ["child-a", "child-b", "child-c", "child-d", "child-e"] as const;

function assistant(timestamp: number, toolCallId: string, name: string): NekAssistantMessage {
  return {
    role: "assistant",
    timestamp,
    provider: "mock",
    model: "local-only",
    api: "openai-completions",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: toolCallId, name, arguments: { description: toolCallId } }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function record(
  id: string,
  status: NekSubagentRecord["status"],
  overrides: Partial<NekSubagentRecord> = {},
): NekSubagentRecord {
  return {
    id,
    description: `Inspect ${id}`,
    type: "worker",
    background: true,
    status,
    startedAt: 1_000,
    sessionFile: `/sessions/subagents/${id}.jsonl`,
    ...(status === "running" ? {} : { endedAt: 2_000, finalText: `report ${id}` }),
    ...overrides,
  };
}

function entryOf(
  id: string,
  parentId: string | null,
  timestamp: number,
  message: NekAgentMessage,
): NekSessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message,
  };
}

/** 5 次 `subagent` 调用 + 1 次 `await`，全部按 nek 真实的 details 形状写入 entries。 */
function persistedEntries(): NekSessionEntry[] {
  const entries: NekSessionEntry[] = [
    entryOf("entry-user", null, 900, { role: "user", content: "delegate", timestamp: 900 }),
  ];
  const append = (message: NekAgentMessage) => {
    entries.push(
      entryOf(`entry-${entries.length}`, entries.at(-1)?.id ?? null, message.timestamp, message),
    );
  };
  for (const [index, id] of CHILD_IDS.entries()) {
    append(assistant(1_000 + index * 10, `call-${id}`, "subagent"));
    append({
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "subagent",
      content: [{ type: "text", text: `${id} started` }],
      details: { subagent: record(id, "completed") },
      isError: false,
      timestamp: 1_100 + index * 10,
    } satisfies NekToolResultMessage);
  }
  append(assistant(2_000, "call-await", "await"));
  append({
    role: "toolResult",
    toolCallId: "call-await",
    toolName: "await",
    content: [{ type: "text", text: "all done" }],
    details: {
      subagents: CHILD_IDS.map((id) => record(id, "completed", { endedAt: 3_000 })),
      running: [],
      timedOut: false,
      interrupted: false,
    },
    isError: false,
    timestamp: 3_000,
  } satisfies NekToolResultMessage);
  return entries;
}

function subagentRows(snapshot: ConversationSnapshot): SubagentRow[] {
  return snapshot.rows.window.filter((row): row is SubagentRow => row.kind === "subagent");
}

function snapshotFrame(frames: ConversationTopicFrame[]): ConversationSnapshot {
  const snapshotFrames = frames.filter((frame) => frame.payload.kind === "snapshot");
  const frame = snapshotFrames.at(-1);
  assert.ok(frame, "expected a snapshot frame");
  // 走一遍真实 wire 形状：zod 拒帧会让 renderer 整段丢历史。
  const parsed = conversationTopicFrameSchema.parse(JSON.parse(JSON.stringify(frame)));
  assert.equal(parsed.payload.kind, "snapshot");
  if (parsed.payload.kind !== "snapshot") throw new Error("expected a snapshot frame");
  return parsed.payload.snapshot;
}

test("SP-1: toolResult details restore every persisted subagent row with its parent tool call", () => {
  const entries = persistedEntries();
  const projector = new NekConversationProjector({ sessionId: "parent", now: () => 3_000 });
  const frames: ConversationTopicFrame[] = [];
  projector.subscribe((frame) => frames.push(frame));
  try {
    projector.loadSnapshot({ entries, leafId: entries.at(-1)?.id ?? null });
    const rowSnapshot = conversationSnapshotSchema.parse(
      JSON.parse(JSON.stringify(projector.snapshot())),
    );
    const rows = subagentRows(rowSnapshot);
    assert.deepEqual(
      rows.map((row) => [row.childSessionId, row.parentToolCallId]),
      CHILD_IDS.map((id) => [id, `call-${id}`]),
    );
    for (const row of rows) {
      assert.equal(row.status, "success");
      assert.equal(row.subagentType, "worker");
      assert.equal(row.summaryText, `Inspect ${row.childSessionId}`);
      assert.equal(row.startedAt, 1_000);
      // `await` 的更新是同一行的状态刷新：结束时间取最后出现的记录。
      assert.equal(row.endedAt, 3_000);
    }
    assert.deepEqual(rowSnapshot.subagents?.childSessionIds, [...CHILD_IDS]);
    assert.deepEqual(rowSnapshot.subagents?.running, []);
    assert.equal(rowSnapshot.subagents?.endedTotal, 5);
    assert.ok((rowSnapshot.subagents?.revision ?? 0) > 0);
    assert.deepEqual(
      snapshotFrame(frames).rows.window.map((row) => row.entityId),
      rowSnapshot.rows.window.map((row) => row.entityId),
    );
  } finally {
    projector.dispose();
  }
});

test("SP-2: a cold reopen collapses leftover running records instead of faking live work", () => {
  const running = record("child-running", "running", { lastActivityAt: 1_500 });
  const entries = [
    ...persistedEntries(),
    entryOf("entry-running", "entry-8", 4_000, {
      role: "toolResult",
      toolCallId: "call-running",
      toolName: "subagent",
      content: [{ type: "text", text: "started" }],
      details: { subagent: running },
      isError: false,
      timestamp: 4_000,
    } satisfies NekToolResultMessage),
  ];
  const cold = projectEntries({ sessionId: "parent", entries, isSessionRunning: false });
  const coldRow = cold.rows.find((row) => row.entityId === "subagent:child-running");
  assert.equal(coldRow?.kind === "subagent" && coldRow.status, "cancelled");
  assert.equal(coldRow?.kind === "subagent" && coldRow.endedAt, 1_500);

  // 父会话仍在跑时保留 running：正在干活的子代理不能写成 cancelled。
  const live = projectEntries({ sessionId: "parent", entries, isSessionRunning: true });
  const liveRow = live.rows.find((row) => row.entityId === "subagent:child-running");
  assert.equal(liveRow?.kind === "subagent" && liveRow.status, "running");
  assert.equal(liveRow?.kind === "subagent" && liveRow.endedAt, undefined);

  const collected = collectPersistedSubagentRecords(entries, { sessionRunning: false });
  assert.equal(collected.get("child-running")?.record.status, "aborted");
  assert.equal(collected.get("child-running")?.record.endedAt, 1_500);
  assert.equal(collected.get("child-a")?.record.status, "completed");
  assert.equal(collected.get("child-a")?.parentToolCallId, "call-child-a");
  assert.equal(
    collectPersistedSubagentRecords(entries, { sessionRunning: true }).get("child-running")?.record
      .status,
    "running",
  );
});

test("SP-3: only subagent/await/stop_subagent details are read, and the first parent anchor wins", () => {
  assert.deepEqual(
    extractSubagentsFromToolResult("read", "call-1", { subagent: record("x", "completed") }),
    [],
  );
  assert.deepEqual(
    extractSubagentsFromToolResult("subagent", "call-1", { subagent: record("x", "completed") }),
    [{ record: record("x", "completed"), parentToolCallId: "call-1" }],
  );
  assert.deepEqual(
    extractSubagentsFromToolResult("stop_subagent", "call-2", {
      subagent: record("x", "aborted"),
    }),
    [{ record: record("x", "aborted") }],
  );
  assert.deepEqual(
    extractSubagentsFromToolResult("subagent", "call-1", { subagent: { id: "x" } }),
    [],
  );
  assert.equal(
    isNekSubagentRecord({ id: "x", description: "d", type: "worker", status: "running" }),
    false,
  );
  assert.equal(
    isNekSubagentRecord({
      id: "x",
      description: "d",
      type: "worker",
      background: true,
      status: "running",
      startedAt: 1,
    }),
    true,
  );

  const entries: NekSessionEntry[] = [
    entryOf("spawn", null, 1_000, {
      role: "toolResult",
      toolCallId: "call-spawn",
      toolName: "subagent",
      content: [],
      details: { subagent: record("child", "running") },
      isError: false,
      timestamp: 1_000,
    } satisfies NekToolResultMessage),
    entryOf("stop", "spawn", 2_000, {
      role: "toolResult",
      toolCallId: "call-stop",
      toolName: "stop_subagent",
      content: [],
      details: { subagent: record("child", "aborted"), subagentId: "child" },
      isError: false,
      timestamp: 2_000,
    } satisfies NekToolResultMessage),
  ];
  const persisted = collectPersistedSubagentRecords(entries, { sessionRunning: true });
  assert.equal(persisted.get("child")?.record.status, "aborted");
  assert.equal(persisted.get("child")?.parentToolCallId, "call-spawn");
});

function childSnapshot(id: string): NekSessionSnapshot {
  const messages = [
    { role: "user", content: `Inspect ${id}`, timestamp: 1_000 },
    {
      role: "assistant",
      provider: "mock",
      model: "local-only",
      timestamp: 2_000,
      content: [{ type: "text", text: `report ${id}` }],
    },
  ];
  return {
    session: {
      id,
      path: `/sessions/subagents/${id}.jsonl`,
      locked: true,
      cwd: "/project",
      createdAt: "2026-01-01T00:00:01.000Z",
      modifiedAt: "2026-01-01T00:00:02.000Z",
      messageCount: messages.length,
      firstMessage: `Inspect ${id}`,
    },
    entries: messages.map((message, index) =>
      entryOf(
        `child-entry-${index}`,
        index === 0 ? null : `child-entry-${index - 1}`,
        message.timestamp,
        message as NekAgentMessage,
      ),
    ),
    messages,
    leafId: "child-entry-1",
  };
}

test("SP-4: a reopened session backfills the status snapshot and previews history subagents", async () => {
  // 重开 GUI：nek registry 报空，全部子代理只剩 entries 里的持久化记录。
  const h = harness({
    entries: persistedEntries(),
    subagents: [],
    childSnapshots: [childSnapshot("child-a")],
  });
  try {
    const snapshot = await h.adapter.getNekStatusSnapshot(params);
    assert.deepEqual(
      snapshot.state.subagents.map((child) => child.id),
      [...CHILD_IDS],
    );
    for (const child of snapshot.state.subagents) {
      assert.equal(child.status, "completed");
      assert.equal(child.description, `Inspect ${child.id}`);
    }

    const preview = await h.adapter.getSubagentConversation({ ...params, id: "child-a" });
    assert.equal(preview.status, "completed");
    for (const row of preview.rows) conversationRowSchema.parse(row);
    assert.ok(
      preview.rows.some((row) => row.kind === "assistantText" && row.text === "report child-a"),
    );
    assert.equal(preview.rows.find((row) => row.kind === "turnHeader")?.state, "completedSuccess");
    assert.equal(h.sessions.length, 1, "history preview never resumes the child session");
    assert.ok(
      h.control.commands.some(
        (command) =>
          command.type === "read_session_snapshot" &&
          command.sessionPath === "/sessions/subagents/child-a.jsonl",
      ),
    );
    await assert.rejects(
      h.adapter.getSubagentConversation({ ...params, id: "missing-child" }),
      /Unknown subagent missing-child/,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("SP-5: a live registry record still wins over the persisted history for the same id", async () => {
  const h = harness({
    entries: persistedEntries(),
    subagents: [record("child-a", "running")],
  });
  try {
    const snapshot = await h.adapter.getNekStatusSnapshot(params);
    assert.equal(snapshot.state.subagents.length, CHILD_IDS.length);
    assert.equal(
      snapshot.state.subagents.find((child) => child.id === "child-a")?.status,
      "running",
    );
  } finally {
    await h.adapter.dispose();
  }
});
