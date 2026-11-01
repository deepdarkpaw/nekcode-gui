import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekAssistantMessage,
  NekRpcEvent,
  NekSessionEntry,
  NekToolResultMessage,
} from "@zcode/shared/nek-protocol";
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";

const cases = [
  {
    toolName: "ask_question",
    input: { questions: [{ question: "Which branch?" }, { question: "Which path?" }] },
  },
  { toolName: "ls", input: { path: "/project/src" } },
];

function messages(toolName: string, input: Record<string, unknown>) {
  const assistant: NekAssistantMessage = {
    role: "assistant",
    timestamp: 100,
    provider: "mock",
    model: "local-only",
    api: "openai-completions",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "tool-1", name: toolName, arguments: input }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const result: NekToolResultMessage = {
    role: "toolResult",
    timestamp: 300,
    toolCallId: "tool-1",
    toolName,
    content: [{ type: "text", text: "completed" }],
    isError: false,
  };
  const entries: NekSessionEntry[] = [assistant, result].map((message, index) => ({
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : "entry-0",
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  }));
  return { assistant, result, entries };
}

/** Validate the actual v4 wire payloads, then apply the same deltas the renderer consumes. */
function replay(frames: ConversationTopicFrame[]): ConversationSnapshot {
  let snapshot: ConversationSnapshot | undefined;
  for (const frame of frames) {
    const parsed = conversationTopicFrameSchema.parse(JSON.parse(JSON.stringify(frame)));
    if (parsed.payload.kind === "snapshot") snapshot = parsed.payload.snapshot;
    else {
      assert.ok(snapshot);
      assert.equal(parsed.fromSeq, snapshot.seq);
      snapshot = { ...applyConversationDeltas(snapshot, parsed.payload.deltas), seq: parsed.toSeq };
    }
  }
  assert.ok(snapshot);
  return snapshot;
}

function tool(snapshot: ConversationSnapshot): ToolCallRow {
  const rows = snapshot.rows.window.filter((row) => row.kind === "toolCall");
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  return row;
}

for (const { toolName, input } of cases) {
  for (const source of ["message", "execution", "execution-and-message"] as const) {
    test(`TP-1: ${toolName} preserves input in history and ${source} result deltas`, () => {
      const { assistant, result, entries } = messages(toolName, input);
      const history = new NekConversationProjector({ sessionId: "s", now: () => 100 });
      const live = new NekConversationProjector({ sessionId: "s", now: () => 100 });
      const frames: ConversationTopicFrame[] = [];
      live.subscribe((frame) => frames.push(frame));
      try {
        history.loadSnapshot({ entries, leafId: "entry-1" });
        live.loadSnapshot({ entries: [], leafId: null });
        const events: NekRpcEvent[] = [
          { type: "message_start", message: assistant },
          { type: "message_end", message: assistant },
          { type: "tool_execution_start", toolCallId: "tool-1", toolName, args: input },
        ];
        if (source !== "message")
          events.push({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName,
            result,
            isError: false,
          });
        if (source !== "execution") events.push({ type: "message_end", message: result });
        for (const event of events) {
          live.handleEvent(event);
          live.flushNow();
        }
        const beforeRefresh = tool(replay(frames));
        const persisted = tool(history.snapshot());
        assert.equal(beforeRefresh.startedAt, 100);
        for (const row of [beforeRefresh, persisted]) {
          assert.deepEqual(row.input, input);
          assert.equal(row.inputText, JSON.stringify(input, null, 2));
          assert.equal(row.status, "success");
          assert.equal(row.output?.text, "completed");
          assert.equal(row.assistantResponseId, "resp:100");
          assert.equal(row.createdAt, 100);
        }
        if (toolName === "ask_question") {
          const questions = (beforeRefresh.input as { questions: unknown[] }).questions;
          assert.equal(questions.length, 2, "the UI must not render zero questions");
        } else assert.equal((beforeRefresh.input as { path: string }).path, "/project/src");
        live.loadSnapshot({ entries, leafId: "entry-1" });
        const refreshed = tool(replay(frames));
        assert.equal(refreshed.rowId, beforeRefresh.rowId);
        assert.deepEqual(refreshed.input, beforeRefresh.input);
        assert.equal(refreshed.inputText, beforeRefresh.inputText);
        assert.deepEqual(refreshed.output, beforeRefresh.output);
      } finally {
        history.dispose();
        live.dispose();
      }
    });
  }
}

test("TP-2: an execution result without a prior row is projected immediately", () => {
  const projector = new NekConversationProjector({ sessionId: "s", now: () => 100 });
  try {
    projector.handleEvent({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "ls",
      result: { content: [{ type: "text", text: "failed" }] },
      isError: true,
    });
    const row = tool(projector.snapshot());
    assert.equal(row.status, "error");
    assert.equal(row.output?.text, "failed");
    assert.equal(row.error?.code, "tool_error");
  } finally {
    projector.dispose();
  }
});

test("TP-3: a partial execution result carries both input and output without a start event", () => {
  const projector = new NekConversationProjector({ sessionId: "s", now: () => 100 });
  try {
    projector.handleEvent({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "ls",
      args: { path: "/project/src" },
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    const row = tool(projector.snapshot());
    assert.equal(row.status, "running");
    assert.deepEqual(row.input, { path: "/project/src" });
    assert.ok(row.inputText.includes("/project/src"));
    assert.equal(row.output?.text, "partial");
  } finally {
    projector.dispose();
  }
});
