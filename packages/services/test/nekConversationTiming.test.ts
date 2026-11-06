import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekAssistantMessage,
  NekRpcSessionState,
  NekSessionEntry,
  NekUsage,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";

const usage: NekUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const state: NekRpcSessionState = {
  sessionId: "s",
  thinkingLevel: "high",
  isStreaming: true,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 2,
  pendingMessageCount: 0,
};
function assistant(
  timestamp: number,
  stopReason: NekAssistantMessage["stopReason"] = "stop",
): NekAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "checking" }],
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    usage,
    timestamp,
    stopReason,
  };
}
function entries(stopReason: NekAssistantMessage["stopReason"] = "stop"): NekSessionEntry[] {
  return [
    {
      id: "u",
      parentId: null,
      type: "message",
      timestamp: new Date(1000).toISOString(),
      message: { role: "user", content: "work", timestamp: 1000 },
    },
    {
      id: "a",
      parentId: "u",
      type: "message",
      timestamp: new Date(65_000).toISOString(),
      message: assistant(2000, stopReason),
    },
  ];
}
function projector() {
  let now = 1000;
  const p = new NekConversationProjector({
    sessionId: "s",
    now: () => now,
    schedule: () => () => undefined,
  });
  return {
    p,
    at: (time: number) => {
      now = time;
    },
  };
}

for (const [stop, expected] of [
  ["stop", "completedSuccess"],
  ["aborted", "completedInterrupted"],
  ["error", "failed"],
] as const) {
  test(`history uses persisted completion time and preserves ${stop} outcome`, () => {
    const { p } = projector();
    try {
      p.loadSnapshot({ entries: entries(stop) });
      const header = p.rows.window.find((row) => row.kind === "turnHeader");
      assert.equal(header?.state, expected);
      assert.equal(header?.startedAt, 1000);
      assert.equal(header?.endedAt, 65_000);
      p.loadSnapshot({ entries: entries(stop) });
      assert.equal(p.rows.window.find((row) => row.kind === "turnHeader")?.endedAt, 65_000);
    } finally {
      p.dispose();
    }
  });
}

test("later settings and next user idle gap are not counted as previous work", () => {
  const { p } = projector();
  try {
    p.loadSnapshot({
      entries: [
        ...entries(),
        {
          id: "setting",
          parentId: "a",
          type: "thinking_level_change",
          timestamp: new Date(500_000).toISOString(),
          thinkingLevel: "high",
        },
        {
          id: "u2",
          parentId: "setting",
          type: "message",
          timestamp: new Date(600_000).toISOString(),
          message: { role: "user", content: "next", timestamp: 600_000 },
        },
        {
          id: "a2",
          parentId: "u2",
          type: "message",
          timestamp: new Date(615_000).toISOString(),
          message: assistant(602_000),
        },
      ],
    });
    const headers = p.rows.window.filter((row) => row.kind === "turnHeader");
    assert.deepEqual(
      headers.map((row) => row.endedAt! - row.startedAt),
      [64_000, 15_000],
    );
  } finally {
    p.dispose();
  }
});

test("running snapshot keeps the original turn and elapsed clock through continuation and settlement", () => {
  const { p, at } = projector();
  try {
    at(80_000);
    p.loadSnapshot({ entries: entries("toolUse"), state });
    const initial = p.rows.window.find((row) => row.kind === "turnHeader");
    assert.equal(initial?.state, "running");
    assert.equal(initial?.endedAt, undefined);
    const message = assistant(80_000);
    p.handleEvent({ type: "message_start", message });
    at(90_000);
    p.handleEvent({ type: "message_end", message });
    p.handleEvent({ type: "agent_settled" });
    const headers = p.rows.window.filter((row) => row.kind === "turnHeader");
    assert.equal(headers.length, 1);
    assert.equal(headers[0]?.turnId, initial?.turnId);
    assert.equal(headers[0]?.startedAt, 1000);
    assert.equal(headers[0]?.endedAt, 90_000);
  } finally {
    p.dispose();
  }
});

test("thinking duration ends at thinking_end, not message_end or component mount", () => {
  const { p, at } = projector();
  try {
    const message = assistant(1000);
    p.handleEvent({ type: "message_start", message });
    at(2000);
    p.handleEvent({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    at(5000);
    p.handleEvent({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "checking" },
    });
    at(14_000);
    p.handleEvent({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "checking" },
    });
    const finished = p.rows.window.find((row) => row.kind === "reasoning");
    assert.equal(finished?.state, "complete");
    assert.equal(finished?.durationMs, 12_000);
    at(60_000);
    p.handleEvent({ type: "message_end", message });
    const final = p.rows.window.find((row) => row.kind === "reasoning");
    assert.equal(final?.durationMs, 12_000);
    assert.equal(final?.createdAt, 2000);
  } finally {
    p.dispose();
  }
});

test("a reasoning end received without its start does not fabricate elapsed time", () => {
  const { p, at } = projector();
  try {
    const message = assistant(1000);
    p.handleEvent({ type: "message_start", message });
    at(14_000);
    p.handleEvent({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "checking" },
    });
    at(60_000);
    p.handleEvent({ type: "message_end", message });
    assert.equal(p.rows.window.find((row) => row.kind === "reasoning")?.durationMs, undefined);
  } finally {
    p.dispose();
  }
});

test("durable request-start timestamps are not misreported as historical completion times", () => {
  const { p } = projector();
  try {
    const history = entries();
    history[1]!.timestamp = new Date(2000).toISOString();
    p.loadSnapshot({ entries: history });
    assert.equal(p.rows.window.find((row) => row.kind === "turnHeader")?.endedAt, undefined);
  } finally {
    p.dispose();
  }
});

test("observed completion and reasoning timing survive reload, but not a different final response", () => {
  const { p, at } = projector();
  try {
    const message = assistant(2000);
    p.handleEvent({
      type: "message_start",
      message: { role: "user", content: "work", timestamp: 1000 },
    });
    p.handleEvent({ type: "message_start", message });
    at(2000);
    p.handleEvent({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    at(14_000);
    p.handleEvent({
      type: "message_update",
      usage,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "checking" },
    });
    at(65_000);
    p.handleEvent({ type: "message_end", message });
    p.handleEvent({ type: "agent_settled" });
    const history = entries();
    history[1]!.timestamp = new Date(2000).toISOString();
    p.loadSnapshot({ entries: history });
    assert.equal(p.rows.window.find((row) => row.kind === "turnHeader")?.endedAt, 65_000);
    assert.equal(p.rows.window.find((row) => row.kind === "reasoning")?.durationMs, 12_000);
    const different = entries();
    different[1] = {
      id: "other",
      parentId: "u",
      type: "message",
      timestamp: new Date(3000).toISOString(),
      message: assistant(3000),
    };
    p.loadSnapshot({ entries: different });
    assert.equal(p.rows.window.find((row) => row.kind === "turnHeader")?.endedAt, undefined);
    assert.equal(p.rows.window.find((row) => row.kind === "reasoning")?.durationMs, undefined);
  } finally {
    p.dispose();
  }
});

test("pending steering is removed by nek queue consumption, not duplicated as another pending message", () => {
  const { p } = projector();
  try {
    p.handleEvent({ type: "agent_start" });
    p.handleEvent({
      type: "message_start",
      message: { role: "user", content: "first", timestamp: 1000 },
    });
    p.handleEvent({
      type: "queue_update",
      steering: ["打磨细节，规范风格"],
      followUp: ["next task"],
    });
    assert.equal(p.snapshot().queue.items[0]?.delivery.admitted, "guide");
    p.handleEvent({ type: "queue_update", steering: [], followUp: ["next task"] });
    p.handleEvent({
      type: "message_start",
      message: { role: "user", content: "打磨细节，规范风格", timestamp: 2000 },
    });
    assert.equal(
      p.snapshot().queue.items.some((item) => item.delivery.admitted === "guide"),
      false,
    );
    assert.equal(
      p.rows.window.filter((row) => row.kind === "userInput" && row.text === "打磨细节，规范风格")
        .length,
      1,
    );
  } finally {
    p.dispose();
  }
});
