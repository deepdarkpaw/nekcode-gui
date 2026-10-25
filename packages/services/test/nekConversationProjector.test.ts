import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { NekRpcEvent, NekSessionEntry, NekUsage } from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";

/**
 * 投影器的验收方式：用按 nek 文档手写的事件流回放，断言
 * 1. 行（种类、状态、文本、稳定身份）；
 * 2. 帧（快照在前、增量衔接 fromSeq === 上一帧 toSeq、能被 v4 apply 还原）。
 *
 * "客户端视角"一律用 `applyConversationDeltas` 重放，而不是直接读投影器内部状态：
 * 只有这样才能证明 UI 的 `conversationProjectionStore` 会看到同样的东西。
 */

const usage: NekUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function createScheduler() {
  const queue: Array<{ run: () => void }> = [];
  return {
    schedule: (run: () => void) => {
      const entry = { run };
      queue.push(entry);
      return () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
    },
    flushAll: () => {
      while (queue.length > 0) queue.shift()?.run();
    },
    size: () => queue.length,
  };
}

function createProjector() {
  const frames: ConversationTopicFrame[] = [];
  const scheduler = createScheduler();
  let now = 1_000;
  const projector = new NekConversationProjector({
    sessionId: "session-1",
    subscriptionId: "sub-1",
    schedule: scheduler.schedule,
    now: () => now,
  });
  projector.subscribe((frame) => frames.push(frame));
  return { projector, frames, scheduler, advance: (ms: number) => (now += ms) };
}

/** 把帧序列重放成客户端快照。 */
function replay(frames: readonly ConversationTopicFrame[]): ConversationSnapshot {
  let snapshot: ConversationSnapshot | undefined;
  for (const frame of frames) {
    conversationTopicFrameSchema.parse(JSON.parse(JSON.stringify(frame)));
    if (frame.payload.kind === "snapshot") {
      snapshot = frame.payload.snapshot;
      continue;
    }
    assert.ok(snapshot, "delta frame before any snapshot");
    assert.equal(
      frame.fromSeq,
      snapshot.seq,
      "delta frame must continue from the applied snapshot",
    );
    snapshot = { ...applyConversationDeltas(snapshot, frame.payload.deltas), seq: frame.toSeq };
  }
  assert.ok(snapshot, "no frames captured");
  return snapshot;
}

const entries: NekSessionEntry[] = [
  {
    type: "message",
    id: "e1",
    parentId: null,
    timestamp: iso(1_000),
    message: { role: "user", content: "hello", timestamp: 1_000 },
  },
  {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: iso(2_000),
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me look" },
        { type: "text", text: "hi there" },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet",
      usage,
      stopReason: "toolUse",
      timestamp: 2_000,
    },
  },
  {
    type: "message",
    id: "e3",
    parentId: "e2",
    timestamp: iso(3_000),
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "file.txt" }],
      details: { truncated: false },
      isError: false,
      timestamp: 3_000,
    },
  },
  {
    type: "model_change",
    id: "e4",
    parentId: "e3",
    timestamp: iso(4_000),
    provider: "openai",
    modelId: "gpt-5",
  },
  {
    type: "compaction",
    id: "e5",
    parentId: "e4",
    timestamp: iso(5_000),
    summary: "summary",
    firstKeptEntryId: "e3",
    tokensBefore: 1_000,
  },
  {
    type: "custom_message",
    id: "e6",
    parentId: "e5",
    timestamp: iso(6_000),
    customType: "nek.plan_preview",
    content: "plan",
    display: true,
    details: {
      plan: { name: "Plan A", path: "/p/plan.md", revision: 2, overview: "overview" },
      markdown: "# Plan A\n",
    },
  },
];

test("projects entries into v4 rows and emits a full snapshot first", () => {
  const { projector, frames } = createProjector();
  projector.loadSnapshot({ entries, leafId: "e6" });
  projector.flushNow();
  assert.equal(frames.length, 2, "subscribe snapshot + loadSnapshot snapshot");
  const snapshot = replay(frames);
  const kinds = snapshot.rows.window.map((row) => row.kind);
  assert.deepEqual(kinds, [
    "turnHeader",
    "userInput",
    "reasoning",
    "assistantText",
    "toolCall",
    "timelineMarker",
    "timelineMarker",
    "artifact",
  ]);
  const [header, user, reasoning, text, tool, modelChange, compact, plan] = snapshot.rows.window;
  assert.equal(header?.kind === "turnHeader" && header.state, "completedSuccess");
  assert.equal(user?.kind === "userInput" && user.text, "hello");
  assert.equal(reasoning?.kind === "reasoning" && reasoning.text, "let me look");
  assert.equal(text?.kind === "assistantText" && text.text, "hi there");
  assert.equal(tool?.kind === "toolCall" && tool.status, "success");
  assert.equal(tool?.kind === "toolCall" && tool.output?.text, "file.txt");
  assert.ok(tool?.kind === "toolCall" && tool.output?.display?.kind === "bash_output");
  assert.equal(modelChange?.kind === "timelineMarker" && modelChange.marker.type, "modelChange");
  assert.equal(compact?.kind === "timelineMarker" && compact.marker.type, "compact");
  assert.equal(plan?.kind === "artifact" && plan.displayName, "Plan A");
  // 行身份稳定：entryId + 内容块序号 / toolCallId。
  assert.equal(text?.entityId, "entry:e2:text:1");
  assert.equal(tool?.entityId, "tool:call_1");
  assert.equal(snapshot.config.provider, "openai");
  assert.equal(snapshot.config.model, "gpt-5");
});

test("live event replay produces a coalesced delta stream that recreates the same rows", () => {
  const { projector, frames, scheduler, advance } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  const events: NekRpcEvent[] = [
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: "list files", timestamp: 2_000 } },
    { type: "message_end", message: { role: "user", content: "list files", timestamp: 2_000 } },
    {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet",
        usage,
        stopReason: "pending",
        timestamp: 3_000,
      },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Let me " },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "check." },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "reasons" },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 2,
        id: "call_9",
        toolName: "bash",
      },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: '{"command":' },
    },
    {
      type: "message_update",
      usage,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: { type: "toolCall", id: "call_9", name: "bash", arguments: { command: "ls" } },
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "thinking", thinking: "reasons" },
          { type: "toolCall", id: "call_9", name: "bash", arguments: { command: "ls" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet",
        usage,
        stopReason: "toolUse",
        timestamp: 3_000,
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "call_9",
      toolName: "bash",
      args: { command: "ls" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "call_9",
      toolName: "bash",
      args: { command: "ls" },
      partialResult: { content: [{ type: "text", text: "file.txt" }] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_9",
      toolName: "bash",
      result: { content: [{ type: "text", text: "file.txt" }], details: { truncated: false } },
      isError: false,
    },
    { type: "compaction_start", reason: "threshold" },
    {
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 900, estimatedTokensAfter: 300 },
      aborted: false,
      willRetry: false,
    },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529" },
    { type: "agent_settled" },
  ];
  // 每条事件后都刷一帧：这样才能观察到"先 appended、再 row.delta、终态 upsert"的全过程。
  for (const event of events) {
    projector.handleEvent(event);
    advance(10);
    scheduler.flushAll();
  }
  const snapshot = replay(frames);
  const kinds = snapshot.rows.window.map((row) => row.kind);
  assert.deepEqual(kinds, [
    "turnHeader",
    "userInput",
    "assistantText",
    "reasoning",
    "toolCall",
    "timelineMarker",
    "timelineMarker",
    "timelineMarker",
  ]);
  const text = snapshot.rows.window.find((row) => row.kind === "assistantText");
  assert.equal(text?.kind === "assistantText" && text.text, "Let me check.");
  assert.equal(text?.kind === "assistantText" && text.state, "complete");
  const tool = snapshot.rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool?.kind === "toolCall" && tool.status, "success");
  assert.equal(tool?.kind === "toolCall" && tool.output?.text, "file.txt");
  assert.equal(tool?.kind === "toolCall" && tool.inputText.includes("ls"), true);
  const header = snapshot.rows.window[0];
  assert.equal(header?.kind === "turnHeader" && header.state, "completedSuccess");
  const markers = snapshot.rows.window.filter((row) => row.kind === "timelineMarker");
  assert.deepEqual(
    markers.map((marker) => (marker.kind === "timelineMarker" ? marker.marker.type : "")),
    ["compact", "compact", "retryNotice"],
  );
  // 客户端重放出来的行必须与投影器内部状态逐行一致（增量没漏、没重）。
  assert.deepEqual(
    snapshot.rows.window.map((row) => [row.rowId, row.kind, row.entityId]),
    projector.snapshot().rows.window.map((row) => [row.rowId, row.kind, row.entityId]),
  );
  const ops = frames.flatMap((frame) =>
    frame.payload.kind === "deltas" ? frame.payload.deltas : [],
  );
  assert.ok(ops.length > 1);
  // 文本增长走 row.delta（追加），终态才整行 upsert。
  assert.ok(ops.some((delta) => delta.op === "row.delta" && delta.path === "text"));
  assert.ok(ops.some((delta) => delta.op === "row.upserted"));
});

test("streaming appends are coalesced into at most 20 flushes per second", () => {
  const { projector, frames, scheduler, advance } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "go", timestamp: 1_000 },
  });
  projector.handleEvent({
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "p",
      model: "m",
      usage,
      stopReason: "pending",
      timestamp: 2_000,
    },
  });
  const startFrames = frames.length;
  // 40 个 token，每 5 ms 一个：50 ms 的合并窗口内应当只排一次 flush。
  for (let index = 0; index < 40; index += 1) {
    projector.handleEvent({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `t${index} ` },
    });
    advance(5);
  }
  assert.equal(scheduler.size(), 1, "only one flush should be scheduled per window");
  scheduler.flushAll();
  assert.equal(frames.length, startFrames + 1);
  const snapshot = replay(frames);
  const text = snapshot.rows.window.find((row) => row.kind === "assistantText");
  assert.equal(text?.kind === "assistantText" && text.text.includes("t39"), true);
});

test("re-subscribing yields a fresh full snapshot at the current water mark", () => {
  const { projector, frames, scheduler } = createProjector();
  projector.loadSnapshot({ entries, leafId: "e6" });
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "hi", timestamp: 8_000 },
  });
  scheduler.flushAll();
  const before = frames.length;
  const resubscribed: ConversationTopicFrame[] = [];
  projector.subscribe((frame) => resubscribed.push(frame));
  assert.equal(resubscribed.length, 1);
  assert.equal(resubscribed[0]?.payload.kind, "snapshot");
  assert.equal(resubscribed[0]?.fromSeq, 0);
  assert.ok((resubscribed[0]?.toSeq ?? 0) > 0);
  assert.equal(
    resubscribed[0]?.payload.kind === "snapshot" ? resubscribed[0].payload.snapshot.meta.title : "",
    "",
  );
  // 快照水位与后续增量衔接：下一帧必须从快照的 seq 继续。
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "next", timestamp: 9_000 },
  });
  scheduler.flushAll();
  // 原订阅者也会收到这条增量帧（快照只发给新订阅者）。
  assert.equal(frames.length, before + 1);
  const next = resubscribed[1];
  assert.ok(next);
  assert.equal(next.fromSeq, resubscribed[0]?.toSeq);
});

test("subagent tool results become subagent rows with a parent tool call", () => {
  const { projector, scheduler } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "explore", timestamp: 1_000 },
  });
  projector.handleEvent({
    type: "tool_execution_start",
    toolCallId: "call_sub",
    toolName: "subagent",
    args: { description: "look around", type: "explorer" },
  });
  projector.handleEvent({
    type: "tool_execution_end",
    toolCallId: "call_sub",
    toolName: "subagent",
    isError: false,
    result: {
      content: [{ type: "text", text: "done" }],
      details: {
        subagent: {
          id: "child-1",
          description: "look around",
          type: "explorer",
          status: "completed",
          startedAt: 1_100,
          endedAt: 1_900,
          finalText: "found it",
          sessionFile: "/sessions/child-1.jsonl",
        },
      },
    },
  });
  scheduler.flushAll();
  const subagent = projector.snapshot().rows.window.find((row) => row.kind === "subagent");
  assert.equal(subagent?.kind === "subagent" && subagent.status, "success");
  assert.equal(subagent?.kind === "subagent" && subagent.summaryText, "found it");
  assert.equal(subagent?.kind === "subagent" && subagent.parentToolCallId, "call_sub");
  assert.equal(subagent?.kind === "subagent" && subagent.childSessionId, "child-1");
});

test("nek.state todos feed the plan state and cancelled todos are dropped", () => {
  const { projector, scheduler } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({
    type: "extension_event",
    name: "nek.state",
    payload: {
      mode: "plan",
      todos: [
        { id: "1", content: "a", status: "in_progress" },
        { id: "2", content: "b", status: "completed" },
        { id: "3", content: "c", status: "cancelled" },
      ],
      plans: [],
      subagents: [],
    },
  });
  scheduler.flushAll();
  const snapshot = projector.snapshot();
  assert.equal(snapshot.config.mode, "plan");
  assert.deepEqual(
    snapshot.plan?.items.map((item) => `${item.id}:${item.status}`),
    ["1:inProgress", "2:completed"],
  );
});

test("bash command streaming and final result land on one toolCall row", () => {
  const { projector, scheduler } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({ type: "bash_execution_update", id: "req-1", delta: "total 0\n" });
  projector.applyBashCommandResult("req-1", "ls", {
    output: "total 0\nfile.txt\n",
    exitCode: 0,
    cancelled: false,
    truncated: false,
  });
  scheduler.flushAll();
  const row = projector.snapshot().rows.window.find((candidate) => candidate.kind === "toolCall");
  assert.equal(row?.kind === "toolCall" && row.toolName, "bash");
  assert.equal(row?.kind === "toolCall" && row.status, "success");
  assert.equal(row?.kind === "toolCall" && row.output?.text, "total 0\nfile.txt\n");
  assert.equal(
    projector.snapshot().rows.window.filter((candidate) => candidate.kind === "toolCall").length,
    1,
  );
});
