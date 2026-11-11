import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekAgentMessage,
  NekAssistantMessage,
  NekSessionEntry,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";
import { projectEntries } from "../src/nek-agent/projection/nekEntryProjection.js";

const child: NekSubagentRecord = {
  id: "child",
  type: "worker",
  description: "Inspect the workflow",
  background: true,
  status: "running",
  startedAt: 1100,
};
const report =
  "## Verification\n\n**Committed** `abc123`\n\n| Check | Result |\n|---|---|\n| Test | Pass |\n".repeat(
    100,
  );

function assistant(timestamp: number, toolName?: string, call = toolName): NekAssistantMessage {
  return {
    role: "assistant",
    timestamp,
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: toolName ? "toolUse" : "stop",
    content: toolName
      ? [
          {
            type: "toolCall",
            name: toolName,
            id: call!,
            arguments: { description: child.description },
          },
        ]
      : [{ type: "text", text: "pua" }],
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

function fixture() {
  let now = 1000;
  const p = new NekConversationProjector({
    sessionId: "parent",
    now: () => now,
    schedule: () => () => undefined,
  });
  const messages: NekAgentMessage[] = [];
  const message = (value: NekAgentMessage) => {
    now = value.timestamp;
    messages.push(value);
    p.handleEvent({ type: "message_start", message: value });
    p.handleEvent({ type: "message_end", message: value });
  };
  const result = (toolName: string, toolCallId: string, details: unknown, timestamp: number) => {
    now = timestamp;
    const value = { content: [{ type: "text" as const, text: "tool result" }], details };
    p.handleEvent({
      type: "tool_execution_end",
      toolName,
      toolCallId,
      result: value,
      isError: false,
    });
    message({ role: "toolResult", timestamp, toolName, toolCallId, isError: false, ...value });
  };
  p.handleEvent({ type: "agent_start" });
  message({ role: "user", content: "delegate", timestamp: 1000 });
  message(assistant(1100, "subagent", "spawn"));
  result("subagent", "spawn", { subagent: child }, 1200);
  message(assistant(1300, "await", "wait-1"));
  result("await", "wait-1", { subagents: [], running: [child], interrupted: true }, 2000);
  message({ role: "user", content: "reply pua", timestamp: 2100 });
  return {
    p,
    message,
    result,
    entries: (): NekSessionEntry[] =>
      messages.map((value, index) => ({
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        type: "message",
        timestamp: new Date(value.timestamp).toISOString(),
        message: value,
      })),
  };
}

test("resume tool rows carry runtime identity live and on replay without moving the original child anchor", () => {
  const { p, message, result, entries } = fixture();
  try {
    const resumed = { ...child, type: "preset-worker", model: "test/reasoner" };
    const call = assistant(2200, "subagent", "resume-call");
    const block = call.content[0]!;
    if (block.type !== "toolCall") throw new Error("Expected tool call");
    block.arguments = { description: "Continue workflow", resume: child.id };
    message(call);
    const expected = {
      kind: "subagent_identity",
      id: child.id,
      type: resumed.type,
      model: resumed.model,
    };
    p.handleEvent({
      type: "tool_execution_update",
      toolName: "subagent",
      toolCallId: "resume-call",
      args: block.arguments,
      partialResult: { content: [], details: { subagent: resumed } },
    });
    const partial = p.rows.window.find(
      (row) => row.kind === "toolCall" && row.toolCallId === "resume-call",
    );
    assert.deepEqual(partial?.kind === "toolCall" && partial.output?.display, expected);
    result("subagent", "resume-call", { subagent: resumed }, 2300);
    for (const rows of [
      p.rows.window,
      projectEntries({ sessionId: "parent", entries: entries() }).rows,
    ]) {
      const row = rows.find((row) => row.kind === "toolCall" && row.toolCallId === "resume-call")!;
      const parsed = conversationRowSchema.parse(JSON.parse(JSON.stringify(row)));
      assert.deepEqual(parsed.kind === "toolCall" && parsed.output?.display, expected);
      assert.deepEqual(parsed.kind === "toolCall" && parsed.input, block.arguments);
      const children = rows.filter((row) => row.kind === "subagent");
      assert.equal(children.length, 1);
      assert.equal(children[0]?.parentToolCallId, "spawn");
      assert.equal(children[0]?.subagentType, resumed.type);
    }
  } finally {
    p.dispose();
  }
});

test("ST-1: accepted input ends the old wait's visual turn; subsequent work stays after the input", () => {
  const { p, message, entries } = fixture();
  try {
    message(assistant(2200));
    message(assistant(2300, "powershell", "command"));
    message(assistant(2400, "await", "wait-2"));
    const users = p.rows.window.filter((row) => row.kind === "userInput");
    assert.equal(users.length, 2);
    assert.notEqual(users[0]?.turnId, users[1]?.turnId);
    const oldHeader = p.rows.window.find(
      (row) => row.kind === "turnHeader" && row.turnId === users[0]?.turnId,
    );
    assert.equal(oldHeader?.kind === "turnHeader" && oldHeader.state, "completedSuccess");
    const nextWork = p.rows.window.filter(
      (row) =>
        row.kind === "assistantText" ||
        (row.kind === "toolCall" && ["command", "wait-2"].includes(row.toolCallId)),
    );
    assert.equal(nextWork.length, 3);
    assert.ok(
      nextWork.every((row) => row.turnId === users[1]?.turnId && row.rowId > users[1]!.rowId),
    );
    const replay = projectEntries({ sessionId: "parent", entries: entries() });
    const memberships = (rows: typeof p.rows.window) =>
      rows
        .filter((row) => row.kind === "userInput")
        .map((user) => rows.filter((row) => row.turnId === user.turnId).map((row) => row.kind));
    assert.deepEqual(memberships(p.rows.window), memberships(replay.rows));
  } finally {
    p.dispose();
  }
});

test("ST-2: late child progress and completion preserve the spawn's turn, row and parent anchor", () => {
  const { p } = fixture();
  try {
    const before = p.rows.window.find((row) => row.kind === "subagent")!;
    p.handleEvent({ type: "agent_settled", outcome: "completed" });
    p.handleEvent({ type: "agent_start" });
    p.handleEvent({
      type: "message_start",
      message: { role: "user", content: "next task", timestamp: 3000 },
    });
    p.applySubagent({ ...child, activity: "testing", lastActivityAt: 3100 });
    p.applySubagent({ ...child, status: "completed", endedAt: 3200, finalText: report });
    const after = p.rows.window.find((row) => row.kind === "subagent")!;
    assert.equal(after.rowId, before.rowId);
    assert.equal(after.turnId, before.turnId);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.kind === "subagent" && after.parentToolCallId, "spawn");
    assert.equal(after.kind === "subagent" && after.status, "success");
    assert.equal(after.kind === "subagent" && after.summaryText, child.description);
    assert.equal(after.kind === "subagent" && after.backgrounded, true);
  } finally {
    p.dispose();
  }
});

for (const toolName of ["await", "stop_subagent"] as const) {
  test(`ST-3: ${toolName} details update the same child live and on replay, without extension events`, () => {
    const { p, message, result, entries } = fixture();
    try {
      message(assistant(2300, toolName, "status-call"));
      const completed: NekSubagentRecord = {
        ...child,
        status: toolName === "await" ? "completed" : "aborted",
        endedAt: 2500,
        finalText: report,
      };
      result(
        toolName,
        "status-call",
        toolName === "await" ? { subagents: [completed], running: [] } : { subagent: completed },
        2500,
      );
      const rows = p.rows.window.filter((row) => row.kind === "subagent");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, toolName === "await" ? "success" : "cancelled");
      assert.equal(rows[0]?.summaryText, child.description);
      const replay = projectEntries({ sessionId: "parent", entries: entries() }).rows.filter(
        (row) => row.kind === "subagent",
      );
      assert.equal(replay.length, 1);
      assert.equal(replay[0]?.status, rows[0]?.status);
      assert.equal(replay[0]?.parentToolCallId, "spawn");
    } finally {
      p.dispose();
    }
  });
}

test("ST-2: restoring a snapshot does not let the next child event steal the current turn", () => {
  const { p, entries, message } = fixture();
  try {
    p.loadSnapshot({ entries: entries() });
    const before = p.rows.window.find((row) => row.kind === "subagent")!;
    p.handleEvent({ type: "agent_start" });
    message({ role: "user", content: "another input", timestamp: 3000 });
    p.applySubagent({ ...child, status: "completed", endedAt: 3200, finalText: report });
    const after = p.rows.window.find((row) => row.kind === "subagent")!;
    assert.equal(after.turnId, before.turnId);
    assert.equal(after.rowId, before.rowId);
    assert.equal(after.kind === "subagent" && after.parentToolCallId, "spawn");
  } finally {
    p.dispose();
  }
});

test("ST-2: a delayed spawn result anchors the first child fact to its tool rather than the active turn", () => {
  const { p, message } = fixture();
  try {
    message(assistant(2200, "subagent", "late-spawn"));
    const parent = p.rows.window.find(
      (row) => row.kind === "toolCall" && row.toolCallId === "late-spawn",
    )!;
    message({ role: "user", content: "new task", timestamp: 3000 });
    p.handleEvent({
      type: "tool_execution_end",
      toolName: "subagent",
      toolCallId: "late-spawn",
      isError: false,
      result: {
        content: [{ type: "text", text: report }],
        details: { subagent: { ...child, id: "late-child", status: "completed", endedAt: 3100 } },
      },
    });
    const late = p.rows.window.find(
      (row) => row.kind === "subagent" && row.childSessionId === "late-child",
    );
    assert.equal(late?.turnId, parent.turnId);
    assert.equal(late?.kind === "subagent" && late.parentToolCallId, "late-spawn");
    const tool = p.rows.window.find(
      (row) => row.kind === "toolCall" && row.toolCallId === "late-spawn",
    );
    assert.equal(tool?.kind === "toolCall" && tool.output?.text, report);
    assert.equal(late?.kind === "subagent" && late.summaryText, child.description);
  } finally {
    p.dispose();
  }
});

test("ST-3: duplicate tool results and malformed subagent details never invent a new child", () => {
  const { p, result } = fixture();
  try {
    result("await", "wait-1", { subagents: [{ id: "bad" }], running: [] }, 2400);
    const children = p.rows.window.filter((row) => row.kind === "subagent");
    assert.equal(children.length, 1);
    assert.equal(children[0]?.status, "running");
    assert.equal(
      p.rows.window.filter((row) => row.kind === "toolCall" && row.toolCallId === "wait-1").length,
      1,
    );
  } finally {
    p.dispose();
  }
});
