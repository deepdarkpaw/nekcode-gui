import assert from "node:assert/strict";
import test from "node:test";
import type { NekAssistantMessage, NekSessionEntry } from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { settleNekWorkRow } from "../src/nek-agent/projection/nekSettledWork.js";

const assistant: NekAssistantMessage = {
  role: "assistant",
  timestamp: 1000,
  api: "openai-completions",
  provider: "test",
  model: "test",
  content: [{ type: "toolCall", id: "search", name: "grep", arguments: { pattern: "sizing" } }],
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

for (const outcome of ["aborted", "error"] as const) {
  test(`GS-1: ${outcome} closes incomplete tool input and thinking without inventing success`, () => {
    const p = new NekConversationProjector({ sessionId: "s", schedule: () => () => undefined });
    try {
      p.handleEvent({ type: "agent_start" });
      p.handleEvent({ type: "message_start", message: assistant });
      p.handleEvent({
        type: "message_update",
        usage: assistant.usage,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "checking" },
      });
      p.handleEvent({
        type: "message_update",
        usage: assistant.usage,
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 1,
          id: "search",
          toolName: "grep",
        },
      });
      p.handleEvent({ type: "agent_settled", outcome });
      const snapshot = p.snapshot();
      assert.equal(
        snapshot.control.phase,
        outcome === "aborted" ? "completedInterrupted" : "error",
      );
      assert.equal(
        snapshot.rows.window.find((row) => row.kind === "turnHeader")?.state,
        outcome === "aborted" ? "completedInterrupted" : "failed",
      );
      assert.equal(
        snapshot.rows.window.find((row) => row.kind === "reasoning")?.state,
        "interrupted",
      );
      const tool = snapshot.rows.window.find((row) => row.kind === "toolCall");
      assert.equal(tool?.status, "cancelled");
      assert.equal(snapshot.control.canStop, false);
      assert.equal(snapshot.control.sessionEnded, true);
    } finally {
      p.dispose();
    }
  });
}

test("GS-1: active snapshot tools remain running and independent background work is not cancelled", () => {
  const p = new NekConversationProjector({ sessionId: "s", schedule: () => () => undefined });
  try {
    p.handleEvent({ type: "message_start", message: assistant });
    p.handleEvent({
      type: "tool_execution_start",
      toolCallId: "search",
      toolName: "grep",
      args: {},
    });
    const live = p.snapshot().rows.window.find((row) => row.kind === "toolCall");
    assert.equal(live?.status, "running");
    assert.ok(live?.kind === "toolCall");
    const background = { ...live, backgrounded: true };
    assert.equal(settleNekWorkRow(background), background);
  } finally {
    p.dispose();
  }
});

test("GS-2: reopening a stopped session cancels a persisted tool call without a result", () => {
  const p = new NekConversationProjector({ sessionId: "s", schedule: () => () => undefined });
  const entries: NekSessionEntry[] = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: new Date(500).toISOString(),
      message: { role: "user", content: "search", timestamp: 500 },
    },
    {
      type: "message",
      id: "call",
      parentId: "user",
      timestamp: new Date(1000).toISOString(),
      message: assistant,
    },
  ];
  try {
    p.loadSnapshot({ entries });
    assert.equal(
      p.snapshot().rows.window.find((row) => row.kind === "toolCall")?.status,
      "cancelled",
    );
  } finally {
    p.dispose();
  }
});
