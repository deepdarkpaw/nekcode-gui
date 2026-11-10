import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationDeltas,
  applyConversationDelta,
  type ConversationDelta,
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
        { type: "toolCall", id: "call_1", name: "ls", arguments: { path: "/workspace/src" } },
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
      toolName: "ls",
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
    "toolCall",
  ]);
  const [header, user, reasoning, text, tool, modelChange, compact, plan] = snapshot.rows.window;
  assert.equal(header?.kind === "turnHeader" && header.state, "completedSuccess");
  assert.equal(user?.kind === "userInput" && user.text, "hello");
  assert.equal(reasoning?.kind === "reasoning" && reasoning.text, "let me look");
  assert.equal(text?.kind === "assistantText" && text.text, "hi there");
  assert.equal(tool?.kind === "toolCall" && tool.status, "success");
  assert.equal(tool?.kind === "toolCall" && tool.output?.text, "file.txt");
  assert.equal(tool?.kind === "toolCall" && tool.toolName, "ls");
  assert.equal(
    tool?.kind === "toolCall" &&
      typeof tool.input === "object" &&
      tool.input !== null &&
      "path" in tool.input &&
      tool.input.path,
    "/workspace/src",
  );
  assert.equal(tool?.kind === "toolCall" && tool.inputText.includes("/workspace/src"), true);
  assert.equal(modelChange?.kind === "timelineMarker" && modelChange.marker.type, "modelChange");
  assert.equal(compact?.kind === "timelineMarker" && compact.marker.type, "compact");
  assert.equal(plan?.kind === "toolCall" && plan.toolName, "nek.plan");
  assert.ok(plan?.kind === "toolCall" && plan.output?.text);
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
        toolName: "ask_question",
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
        toolCall: {
          type: "toolCall",
          id: "call_9",
          name: "ask_question",
          arguments: { questions: [{ question: "Which path?" }, { question: "Continue?" }] },
        },
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "thinking", thinking: "reasons" },
          {
            type: "toolCall",
            id: "call_9",
            name: "ask_question",
            arguments: { questions: [{ question: "Which path?" }, { question: "Continue?" }] },
          },
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
      toolName: "ask_question",
      args: { questions: [{ question: "Which path?" }, { question: "Continue?" }] },
    },
    {
      type: "tool_execution_update",
      toolCallId: "call_9",
      toolName: "ask_question",
      args: { questions: [{ question: "Which path?" }, { question: "Continue?" }] },
      partialResult: { content: [{ type: "text", text: "file.txt" }] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "call_9",
      toolName: "ask_question",
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
  ]);
  const text = snapshot.rows.window.find((row) => row.kind === "assistantText");
  assert.equal(text?.kind === "assistantText" && text.text, "Let me check.");
  assert.equal(text?.kind === "assistantText" && text.state, "complete");
  const tool = snapshot.rows.window.find((row) => row.kind === "toolCall");
  assert.equal(tool?.kind === "toolCall" && tool.status, "success");
  assert.equal(tool?.kind === "toolCall" && tool.output?.text, "file.txt");
  assert.equal(tool?.kind === "toolCall" && tool.toolName, "ask_question");
  assert.equal(tool?.kind === "toolCall" && tool.inputText.includes("Continue?"), true);
  assert.equal(
    tool?.kind === "toolCall" &&
      typeof tool.input === "object" &&
      tool.input !== null &&
      "questions" in tool.input &&
      Array.isArray(tool.input.questions) &&
      tool.input.questions.length,
    2,
  );
  const header = snapshot.rows.window[0];
  assert.equal(header?.kind === "turnHeader" && header.state, "completedSuccess");
  const markers = snapshot.rows.window.filter((row) => row.kind === "timelineMarker");
  // 一次压缩只占一条 marker row：compaction_start 发 appended(running)，
  // compaction_end 复用同一 rowId 发 upserted(success)。
  assert.deepEqual(
    markers.map((marker) => (marker.kind === "timelineMarker" ? marker.marker.type : "")),
    ["compact", "retryNotice"],
  );
  assert.deepEqual(
    markers.map((marker) =>
      marker.kind === "timelineMarker" && marker.marker.type === "compact"
        ? marker.marker.status
        : "",
    ),
    ["success", ""],
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

/** 客户端 replay 出来的 compact marker（带 rowId，用来证明同一次压缩始终是同一行）。 */
function compactMarkerRows(snapshot: ConversationSnapshot): Array<{
  rowId: number;
  marker: Extract<
    Extract<ConversationSnapshot["rows"]["window"][number], { kind: "timelineMarker" }>["marker"],
    { type: "compact" }
  >;
}> {
  return snapshot.rows.window.flatMap((row) =>
    row.kind === "timelineMarker" && row.marker.type === "compact"
      ? [{ rowId: row.rowId, marker: row.marker }]
      : [],
  );
}

test("compaction running -> success stays on one marker row", () => {
  const { projector, frames, scheduler, advance } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "compact me", timestamp: 1_000 },
  });
  projector.handleEvent({ type: "compaction_start", reason: "threshold" });
  advance(10);
  scheduler.flushAll();

  const started = replay(frames);
  const runningCompacts = compactMarkerRows(started);
  assert.equal(runningCompacts.length, 1);
  assert.equal(runningCompacts[0]?.marker.status, "running");
  assert.equal(runningCompacts[0]?.marker.origin, "auto");
  assert.equal(started.control.stopTargetKind, "compact");
  assert.equal(started.control.canStop, true);
  assert.equal(started.inputRouting.mode, "enqueue");
  assert.equal(started.inputRouting.reasonCode, "compactingAcceptsFutureInput");
  assert.equal(started.availability.compact.allowed, false);
  assert.equal(started.availability.sendQueuedNow.allowed, false);
  assert.equal(
    started.control.activeWorks.some((work) => work.kind === "compact"),
    true,
  );
  const compactRowId = runningCompacts[0]?.rowId;

  projector.handleEvent({
    type: "compaction_end",
    reason: "threshold",
    result: { tokensBefore: 900, estimatedTokensAfter: 300 },
    aborted: false,
    willRetry: false,
  });
  advance(10);
  scheduler.flushAll();

  const settled = replay(frames);
  const settledCompacts = compactMarkerRows(settled);
  // 关键不变量：压缩终态就地 upsert 起始行，不新增第二条 compact 行。
  assert.equal(settledCompacts.length, 1);
  assert.equal(settledCompacts[0]?.rowId, compactRowId);
  assert.equal(settledCompacts[0]?.marker.status, "success");
  assert.equal(settledCompacts[0]?.marker.origin, "auto");
  assert.equal(settledCompacts[0]?.marker.tokensBefore, 900);
  assert.equal(settledCompacts[0]?.marker.tokensAfter, 300);
  // 残留的 running 行会让「正在压缩上下文」永久悬挂并阻塞 chatLoadingVisibility。
  assert.equal(
    settled.rows.window.filter(
      (row) =>
        row.kind === "timelineMarker" &&
        row.marker.type === "compact" &&
        row.marker.status === "running",
    ).length,
    0,
  );
  // 压缩结束后停止目标回到仍在本轮运行中的 assistant。
  assert.equal(settled.control.stopTargetKind, "assistant");
  assert.equal(settled.control.canStop, true);
  // 客户端重放的行必须与投影器内部状态逐行一致（upsert 没漏）。
  assert.deepEqual(
    settled.rows.window.map((row) => [row.rowId, row.kind, row.entityId]),
    projector.snapshot().rows.window.map((row) => [row.rowId, row.kind, row.entityId]),
  );
});

test("the compaction entry appended after compaction_end fills the same marker row", () => {
  const { projector, frames, scheduler, advance } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({ type: "compaction_start", reason: "threshold" });
  advance(10);
  scheduler.flushAll();
  const compactRowId = compactMarkerRows(replay(frames))[0]?.rowId;

  projector.handleEvent({
    type: "compaction_end",
    reason: "threshold",
    result: { tokensBefore: 900, estimatedTokensAfter: 300 },
    aborted: false,
    willRetry: false,
  });
  projector.handleEvent({
    type: "entry_appended",
    entry: {
      type: "compaction",
      id: "c1",
      parentId: null,
      timestamp: iso(1_400),
      summary: "summary text",
      firstKeptEntryId: "e2",
      tokensBefore: 880,
    },
  });
  advance(10);
  scheduler.flushAll();

  const snapshot = replay(frames);
  const compacts = compactMarkerRows(snapshot);
  // 紧随其后的 entry 只是补摘要引用，不能再造第二条 compact 行。
  assert.equal(compacts.length, 1);
  assert.equal(compacts[0]?.rowId, compactRowId);
  assert.equal(compacts[0]?.marker.status, "success");
  assert.equal(compacts[0]?.marker.summaryRef, "c1");
  assert.equal(compacts[0]?.marker.tokensBefore, 880);
});

test("a retried compaction still converges to a single marker row", () => {
  const { projector, frames, scheduler, advance } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({ type: "agent_start" });
  projector.handleEvent({ type: "compaction_start", reason: "overflow" });
  advance(10);
  scheduler.flushAll();
  const runningRowId = compactMarkerRows(replay(frames))[0]?.rowId;

  // willRetry：这一轮尝试失败但会自动重试，压缩仍在进行，保持 running 与 compact 停止目标。
  projector.handleEvent({
    type: "compaction_end",
    reason: "overflow",
    aborted: false,
    willRetry: true,
    errorMessage: "529",
  });
  advance(10);
  scheduler.flushAll();
  const retrying = replay(frames);
  const retryingCompacts = compactMarkerRows(retrying);
  assert.equal(retryingCompacts.length, 1);
  assert.equal(retryingCompacts[0]?.rowId, runningRowId);
  assert.equal(retryingCompacts[0]?.marker.status, "running");
  assert.equal(retrying.control.stopTargetKind, "compact");
  assert.equal(retrying.control.canStop, true);

  // 重试轮复用同一行：start 只把该行刷新回 running，end 才写终态。
  projector.handleEvent({ type: "compaction_start", reason: "overflow" });
  advance(10);
  scheduler.flushAll();
  assert.equal(compactMarkerRows(replay(frames)).length, 1);
  projector.handleEvent({
    type: "compaction_end",
    reason: "overflow",
    result: { tokensBefore: 700, estimatedTokensAfter: 200 },
    aborted: false,
    willRetry: false,
  });
  advance(10);
  scheduler.flushAll();

  const settled = replay(frames);
  const settledCompacts = compactMarkerRows(settled);
  assert.equal(settledCompacts.length, 1);
  assert.equal(settledCompacts[0]?.rowId, runningRowId);
  assert.equal(settledCompacts[0]?.marker.status, "success");
  assert.equal(settledCompacts[0]?.marker.tokensBefore, 700);
  assert.equal(settledCompacts[0]?.marker.tokensAfter, 200);
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

test("session state and stats fill the context window usage", () => {
  const { projector, scheduler } = createProjector();
  projector.loadSnapshot({ entries, leafId: "e6" });
  projector.applySessionState(
    {
      thinkingLevel: "high",
      isStreaming: false,
      isCompacting: false,
      steeringMode: "all",
      followUpMode: "one-at-a-time",
      sessionId: "session-1",
      autoCompactionEnabled: true,
      messageCount: 6,
      pendingMessageCount: 0,
      model: {
        id: "gpt-5",
        name: "GPT-5",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        reasoning: true,
      },
    },
    {
      sessionFile: "/s.jsonl",
      sessionId: "session-1",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 4,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      contextUsage: { tokens: 12_345, contextWindow: 400_000, percent: 3 },
    },
  );
  scheduler.flushAll();
  const usageState = projector.snapshot().usage;
  assert.deepEqual(usageState.contextWindow, {
    usedTokens: 12_345,
    maxTokens: 400_000,
    autoCompactThresholdTokens: null,
  });
  assert.equal(projector.snapshot().config.thought, "high");
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
          background: false,
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
  assert.equal(subagent?.kind === "subagent" && subagent.summaryText, "look around");
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

test("hidden custom messages (skill_mention) never produce a visible row", () => {
  const { projector, scheduler } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  const typed = "@agent:explorer 找出读取 config.yaml 的地方，再用 @skill:pdf 整理成 PDF";
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: typed, timestamp: 1_000 },
  });
  projector.handleEvent({
    type: "message_end",
    message: { role: "user", content: typed, timestamp: 1_000 },
  });
  // nek 把 skill 的完整说明作为隐藏消息紧跟用户消息之后发给模型。
  const hidden = {
    role: "custom" as const,
    customType: "skill_mention",
    // 多行内容用模板字符串：`\n` 在这里是真实换行，与 nek 写入的 <skill> 块一致。
    content: `<skill name="pdf" location="/skills/pdf/SKILL.md">
PDF 说明
</skill>`,
    display: false,
    details: { name: "pdf", location: "/skills/pdf/SKILL.md" },
    timestamp: 1_001,
  };
  projector.handleEvent({ type: "message_start", message: hidden });
  projector.handleEvent({ type: "message_end", message: hidden });
  scheduler.flushAll();
  const rows = projector.snapshot().rows.window;
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["turnHeader", "userInput"],
  );
  const user = rows[1];
  // 用户输入原样保留：不在投影层剥离或改写 @agent:/@skill: 记号（高亮交给 UI）。
  assert.equal(user?.kind === "userInput" && user.text, typed);
});

test("hidden custom_message entries are skipped on the entries path", () => {
  const hiddenEntries: NekSessionEntry[] = [
    {
      type: "message",
      id: "h1",
      parentId: null,
      timestamp: iso(1_000),
      message: { role: "user", content: "用 @skill:pdf 看这个", timestamp: 1_000 },
    },
    {
      type: "custom_message",
      id: "h2",
      parentId: "h1",
      timestamp: iso(1_100),
      customType: "skill_mention",
      content: "PDF 说明",
      display: false,
      details: { name: "pdf", location: "/skills/pdf/SKILL.md" },
    },
    {
      type: "message",
      id: "h3",
      parentId: "h2",
      timestamp: iso(2_000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "好的" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet",
        usage,
        stopReason: "stop",
        timestamp: 2_000,
      },
    },
  ];
  const { projector, frames } = createProjector();
  projector.loadSnapshot({ entries: hiddenEntries, leafId: "h3" });
  const snapshot = replay(frames);
  assert.deepEqual(
    snapshot.rows.window.map((row) => row.kind),
    ["turnHeader", "userInput", "assistantText"],
  );
  const user = snapshot.rows.window[1];
  assert.equal(user?.kind === "userInput" && user.text, "用 @skill:pdf 看这个");
});

test("PERF-2: batch delta apply matches sequential semantics without mutating published rows", () => {
  const { projector } = createProjector();
  projector.loadSnapshot({ entries });
  const original = projector.snapshot();
  const before = structuredClone(original);
  const text = original.rows.window.find((row) => row.kind === "assistantText")!;
  const deltas: ConversationDelta[] = [
    ...Array.from({ length: 100 }, () => ({
      op: "row.delta" as const,
      rowId: text.rowId,
      path: "text" as const,
      append: "x",
    })),
    { op: "state.updated", patch: { meta: { title: "changed", titleSource: "custom" } } },
  ];
  assert.deepEqual(
    applyConversationDeltas(original, deltas),
    deltas.reduce(applyConversationDelta, original),
  );
  assert.deepEqual(original, before);
  const updated = applyConversationDeltas(original, deltas);
  assert.equal(updated.rows.window[0], original.rows.window[0]);
  assert.equal(
    applyConversationDeltas(original, [deltas.at(-1)!]).rows.window,
    original.rows.window,
  );
  const structural: ConversationDelta[] = [
    { op: "row.removed", fromRowId: text.rowId },
    { op: "row.appended", row: { ...text, rowId: 10000 } },
    { op: "row.delta", rowId: 10000, path: "text", append: "tail" },
    { op: "row.upserted", row: { ...text, rowId: 10000 } },
  ];
  assert.deepEqual(
    applyConversationDeltas(original, structural),
    structural.reduce(applyConversationDelta, original),
  );
  assert.deepEqual(original, before);
  projector.dispose();
});

test("Q1: queue-only admission and consumption reach the renderer without snapshot recovery", () => {
  const { projector, frames, scheduler } = createProjector();
  projector.handleEvent({ type: "queue_update", steering: ["same", "same"], followUp: [] });
  scheduler.flushAll();
  assert.equal(replay(frames).queue.items.length, 2);
  projector.handleEvent({ type: "queue_update", steering: ["same"], followUp: [] });
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "same", timestamp: 100 },
  });
  scheduler.flushAll();
  assert.equal(replay(frames).queue.items.length, 1);
  projector.handleEvent({ type: "queue_update", steering: [], followUp: [] });
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "same", timestamp: 200 },
  });
  scheduler.flushAll();
  const view = replay(frames);
  assert.equal(view.queue.items.length, 0);
  assert.equal(view.rows.window.filter((row) => row.kind === "userInput").length, 2);
  assert.deepEqual(view.queue, projector.snapshot().queue);
  projector.dispose();
});

test("Q2: pure state changes are emitted once and snapshots reset the pending state baseline", () => {
  const { projector, frames, scheduler } = createProjector();
  projector.handleEvent({ type: "session_info_changed", name: "renamed" });
  projector.handleEvent({ type: "thinking_level_changed", level: "high" });
  projector.handleEvent({ type: "agent_start" });
  scheduler.flushAll();
  const view = replay(frames);
  assert.equal(view.meta.title, "renamed");
  assert.equal(view.config.thought, "high");
  assert.equal(view.control.canStop, true);
  const count = frames.length;
  projector.flushNow();
  assert.equal(frames.length, count);
  projector.loadSnapshot({ entries: [], leafId: null });
  const snapshotCount = frames.length;
  projector.flushNow();
  assert.equal(frames.length, snapshotCount);
  projector.dispose();
});

test("Q3: joining a second subscriber does not consume pending updates or advance the first cursor", () => {
  const { projector, frames, scheduler } = createProjector();
  projector.handleEvent({ type: "queue_update", steering: ["guide"], followUp: [] });
  const second: ConversationTopicFrame[] = [];
  projector.subscribe((frame) => second.push(frame));
  projector.handleEvent({ type: "queue_update", steering: [], followUp: [] });
  scheduler.flushAll();
  assert.deepEqual(replay(frames).queue, replay(second).queue);
  assert.equal(replay(frames).queue.items.length, 0);
  projector.dispose();
});

test("an extension-appended hidden custom message also stays out of the transcript", () => {
  const { projector, scheduler } = createProjector();
  projector.loadSnapshot({ entries: [], leafId: null });
  projector.handleEvent({
    type: "message_start",
    message: { role: "user", content: "go", timestamp: 1_000 },
  });
  projector.handleEvent({
    type: "entry_appended",
    entry: {
      type: "custom_message",
      id: "x1",
      parentId: null,
      timestamp: iso(1_500),
      customType: "skill_mention",
      content: "PDF 说明",
      display: false,
      details: { name: "pdf" },
    },
  });
  scheduler.flushAll();
  assert.deepEqual(
    projector.snapshot().rows.window.map((row) => row.kind),
    ["turnHeader", "userInput"],
  );
});
