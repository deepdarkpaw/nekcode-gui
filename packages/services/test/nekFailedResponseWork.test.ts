import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekAssistantMessage,
  NekHistoryMetadata,
  NekHistoryPage,
  NekHistoryStreamOmission,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { fixtureHistory } from "./nekHistoryFixture.js";
import { settleFailedAssistantResponse } from "../src/nek-agent/projection/nekSettledWork.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const args = { path: "infrastructure/images.py", content: "partial file" };
const call = { type: "toolCall" as const, id: "write-failed", name: "write", arguments: args };
const body: NekHistoryStreamOmission[] = [
  { pointer: "/message", reason: "persisted_body", resolution: "history" },
];
function assistant(
  timestamp = 1000,
  extra: Partial<NekAssistantMessage> = {},
): NekAssistantMessage {
  return {
    role: "assistant",
    timestamp,
    api: "openai-responses",
    provider: "CPA",
    model: "gpt-6.1-sol",
    content: [],
    stopReason: "pending",
    usage,
    ...extra,
  };
}
function projector() {
  const p = new NekConversationProjector({
    sessionId: "s1",
    now: () => 3000,
    schedule: () => () => {},
  });
  p.handleEvent({ type: "agent_start" });
  return p;
}
function streamTool(p: NekConversationProjector, id = call.id, index = 0) {
  p.handleEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: index,
      id,
      toolName: "write",
    },
  });
  p.handleEvent({
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: index,
      delta: "",
      arguments: args,
    },
  });
}
function tool(p: NekConversationProjector, id = call.id) {
  const row = p
    .snapshot()
    .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === id);
  assert.ok(row?.kind === "toolCall");
  return row;
}
function stored(id: string, parentId: string | null, message: unknown): NekSessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-11-17T00:00:03Z",
    message,
  } as NekSessionEntry;
}

for (const stopReason of ["error", "aborted"] as const) {
  for (const retainCall of [true, false]) {
    test(`FW1/FW4: ${stopReason} stops partial writing immediately (final call=${retainCall}) without settling the retrying turn`, () => {
      const p = projector();
      try {
        p.handleEvent({ type: "message_start", message: assistant() });
        streamTool(p);
        p.handleEvent({
          type: "message_end",
          message: assistant(1000, {
            stopReason,
            content: retainCall ? [call] : [],
            errorMessage: "stream failed",
          }),
        });
        assert.equal(tool(p).status, "cancelled");
        assert.deepEqual(tool(p).input, args);
        assert.equal(p.snapshot().control.phase, "running");
        assert.equal(
          p.snapshot().rows.window.find((row) => row.kind === "turnHeader")?.state,
          "running",
        );
        p.handleEvent({ type: "message_start", message: assistant(2000) });
        streamTool(p, "retry-write");
        assert.equal(tool(p).status, "cancelled");
        assert.equal(tool(p, "retry-write").status, "inputStreaming");
      } finally {
        p.dispose();
      }
    });
  }
}

for (const snapshot of [true, false]) {
  test(`FW1: a terminal stream error closes partial tool input (snapshot=${snapshot})`, () => {
    const p = projector();
    try {
      p.handleEvent({ type: "message_start", message: assistant() });
      streamTool(p);
      p.handleEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          ...(snapshot ? { error: assistant(1000, { stopReason: "error" }) } : {}),
        },
      });
      assert.equal(tool(p).status, "cancelled");
    } finally {
      p.dispose();
    }
  });
}

test("FW1: stream error reason overrides an inconsistent terminal snapshot", () => {
  const p = projector();
  try {
    p.handleEvent({ type: "message_start", message: assistant() });
    streamTool(p);
    p.handleEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "aborted",
        error: assistant(1000, { stopReason: "stop", content: [call] }),
      },
    });
    assert.equal(tool(p).status, "cancelled");
    assert.ok(
      !p
        .snapshot()
        .rows.window.some(
          (row) => row.kind === "timelineMarker" && row.marker.type === "modelError",
        ),
    );
  } finally {
    p.dispose();
  }
});

for (const stopReason of ["error", "aborted"] as const) {
  test(`FW2: metadata-only ${stopReason} ends the owning response before any agent_settled`, () => {
    const p = projector();
    try {
      p.handleHistoryEvent(
        { type: "message_start", message: assistant() },
        body,
        "live:response:1",
      );
      streamTool(p);
      p.handleHistoryEvent(
        { type: "message_end", message: assistant(1000, { stopReason }) },
        body,
        "live:response:end",
      );
      assert.equal(tool(p).status, "cancelled");
      assert.equal(p.snapshot().control.phase, "running");
    } finally {
      p.dispose();
    }
  });
}

for (const isError of [false, true]) {
  test(`FW3: late assistant snapshots preserve actual tool results and timing (isError=${isError})`, () => {
    const p = projector();
    try {
      p.handleEvent({ type: "message_start", message: assistant() });
      streamTool(p);
      p.handleEvent({ type: "tool_execution_start", toolCallId: call.id, toolName: "write", args });
      p.handleEvent({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: "write",
        isError,
        result: { content: [{ type: "text", text: isError ? "write failed" : "written" }] },
      });
      const completed = tool(p);
      p.handleEvent({
        type: "message_end",
        message: assistant(1000, { stopReason: "error", content: [call] }),
      });
      const actual = tool(p);
      assert.equal(actual.status, completed.status);
      assert.equal(actual.startedAt, completed.startedAt);
      assert.equal(actual.endedAt, completed.endedAt);
      assert.deepEqual(actual.output, completed.output);
    } finally {
      p.dispose();
    }
  });
}

test("FW3/FW4: other responses and independently backgrounded tools remain running", () => {
  const p = projector();
  try {
    p.handleEvent({ type: "message_start", message: assistant(500) });
    streamTool(p, "earlier-write");
    p.handleEvent({
      type: "tool_execution_start",
      toolCallId: "earlier-write",
      toolName: "write",
      args,
    });
    p.handleEvent({ type: "message_start", message: assistant() });
    streamTool(p);
    const background = { ...tool(p), backgrounded: true as const, status: "running" as const };
    let backgroundUpdates = 0;
    settleFailedAssistantResponse(
      {
        store: {
          window: [background],
          update: () => {
            backgroundUpdates += 1;
          },
        },
        now: () => 3000,
        assistantResponseKey: background.assistantResponseId,
      },
      "error",
    );
    assert.equal(backgroundUpdates, 0);
    p.handleEvent({ type: "message_end", message: assistant(1000, { stopReason: "error" }) });
    assert.equal(tool(p).status, "cancelled");
    assert.equal(tool(p, "earlier-write").status, "running");
  } finally {
    p.dispose();
  }
});

test("FW2: reopening while a retry is active cannot revive the prior failed response's tool", () => {
  const p = projector();
  try {
    p.loadSnapshot({
      entries: [
        stored("u", null, { role: "user", timestamp: 500, content: "write files" }),
        stored("failed", "u", assistant(1000, { stopReason: "error", content: [call] })),
        stored("retry", "failed", assistant(2000, { content: [{ ...call, id: "retry-write" }] })),
      ],
      state: {
        sessionId: "s1",
        isStreaming: true,
        isCompacting: false,
        thinkingLevel: "high",
        messageCount: 3,
        pendingMessageCount: 0,
      },
    });
    assert.equal(tool(p).status, "cancelled");
    assert.equal(tool(p, "retry-write").status, "inputStreaming");
  } finally {
    p.dispose();
  }
});

for (const ordering of ["locator-first", "end-first", "after-retry-start"] as const) {
  test(`FW2: partial tool omitted from persisted failure stays cancelled (${ordering})`, () => {
    const p = projector();
    const entries = [stored("u", null, { role: "user", timestamp: 500, content: "write files" })];
    try {
      p.loadHistory({
        page: fixtureHistory(entries, { type: "read_history_page" }) as NekHistoryPage,
        metadata: fixtureHistory(entries, { type: "read_session_metadata" }) as NekHistoryMetadata,
      });
      p.handleEvent({ type: "agent_start" });
      p.handleHistoryEvent(
        { type: "message_start", message: assistant() },
        body,
        "live:response:1",
      );
      streamTool(p);
      const end = () =>
        p.handleHistoryEvent(
          { type: "message_end", message: assistant(1000, { stopReason: "error" }) },
          body,
          "live:response:end",
        );
      entries.push(
        stored(
          "failed",
          "u",
          assistant(1000, { stopReason: "error", errorMessage: "stream failed" }),
        ),
      );
      if (ordering !== "locator-first") end();
      if (ordering === "after-retry-start") {
        p.handleHistoryEvent(
          { type: "message_start", message: assistant(2000) },
          body,
          "live:retry:1",
        );
        streamTool(p, "retry-write");
      }
      p.applyHistoryTarget(
        fixtureHistory(entries, {
          type: "read_history_page",
          view: "target",
          aroundEntryId: "failed",
        }) as NekHistoryPage,
        "failed",
      );
      assert.equal(tool(p).status, "cancelled");
      if (ordering === "locator-first") end();
      assert.equal(tool(p).status, "cancelled");
      assert.deepEqual(tool(p).input, args);
      if (ordering === "after-retry-start")
        assert.equal(tool(p, "retry-write").status, "inputStreaming");
    } finally {
      p.dispose();
    }
  });
}
