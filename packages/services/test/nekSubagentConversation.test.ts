import assert from "node:assert/strict";
import test from "node:test";
import type { NekSessionSnapshot, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { createZCodeAgentConnectionScope } from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import { createNekSubagentConversationReader } from "../src/nek-agent/adapter/nekSubagentConversation.js";
import { entry, harness, params, sessionId } from "./nekSessionHarness.js";

const child: NekSubagentRecord = {
  id: "child",
  description: "Inspect source",
  type: "worker",
  background: true,
  status: "running",
  startedAt: 1000,
  sessionFile: "/sessions/subagents/child.jsonl",
};
const messages = [
  { role: "user", content: "Inspect source", timestamp: 1000 },
  {
    role: "assistant",
    api: "test",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    provider: "test",
    model: "model",
    timestamp: 2000,
    content: [
      { type: "thinking", thinking: "Inspecting" },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/main.ts" } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    timestamp: 3000,
    isError: false,
    content: [{ type: "text", text: "source contents" }],
  },
  {
    role: "assistant",
    api: "test",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    provider: "test",
    model: "model",
    timestamp: 4000,
    content: [{ type: "text", text: "**Complete**" }],
  },
];
function snapshot(): NekSessionSnapshot {
  return {
    session: {
      id: child.id,
      path: child.sessionFile!,
      locked: true,
      cwd: "/project",
      createdAt: entry.timestamp,
      modifiedAt: entry.timestamp,
      messageCount: messages.length,
      firstMessage: "Inspect source",
    },
    entries: messages.map((message, i) => ({
      type: "message",
      id: `entry-${i}`,
      parentId: i ? `entry-${i - 1}` : null,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    })),
    messages,
    leafId: "entry-3",
  };
}

test("S2/S3: side preview reads a parent's child through the connection facade without resuming it", async () => {
  const record = { ...child };
  const h = harness({
    subagents: [record],
    childSnapshots: [snapshot()],
    subagentMessages: messages,
  });
  const scope = createZCodeAgentConnectionScope(h.adapter, {
    connectionId: "preview",
    clientMode: "desktop-continuous",
  });
  try {
    const preview = await scope.service.getSubagentConversation({ ...params, id: child.id });
    assert.equal(preview.status, "running");
    for (const row of preview.rows) conversationRowSchema.parse(row);
    assert.ok(
      preview.rows.some((row) => row.kind === "assistantText" && row.text === "**Complete**"),
    );
    assert.ok(preview.rows.some((row) => row.kind === "reasoning"));
    assert.ok(preview.rows.some((row) => row.kind === "toolCall" && row.toolName === "read"));
    assert.equal(preview.rows.find((row) => row.kind === "turnHeader")?.state, "running");
    assert.equal(h.sessions.length, 1, "only the parent runtime was opened");
    assert.equal(
      h.control.commands.some(
        (c) => c.type === "read_session_snapshot" && c.sessionPath === child.sessionFile,
      ),
      false,
    );
    record.status = "completed";
    const finished = await scope.service.getSubagentConversation({ ...params, id: child.id });
    assert.equal(finished.status, "completed");
    assert.ok(
      h.sessions[0]!.commands.some(
        (c) => c.type === "read_history_page" && c.sessionPath === child.sessionFile,
      ),
    );
    assert.equal(finished.rows.find((row) => row.kind === "turnHeader")?.state, "completedSuccess");
    assert.equal(h.sessions.length, 1);
    await assert.rejects(
      scope.service.getSubagentConversation({ ...params, id: "other-child" }),
      /Unknown subagent/,
    );
    await scope.dispose();
    await assert.rejects(
      scope.service.getSubagentConversation({ ...params, id: child.id }),
      /closed|disposed/i,
    );
  } finally {
    await scope.dispose();
    await h.adapter.dispose();
  }
});

test("S3: in-memory children use the parent registry, not the ordinary session list", async () => {
  const h = harness({
    subagents: [{ ...child, sessionFile: undefined }],
    subagentMessages: messages,
  });
  try {
    await assert.rejects(
      h.adapter.getSubagentConversation({ ...params, id: child.id }),
      /no persisted bounded transcript/,
    );
    assert.equal(h.sessions.length, 1);
    assert.equal(
      h.sessions[0]!.commands.some(
        (c) => c.type === "extension_call" && c.method === "nek.get_subagent_transcript",
      ),
      false,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("HS5/S3: preview uses explicit source page metadata instead of silently cropping process rows", async () => {
  const h = harness({
    subagents: [{ ...child, status: "completed" }],
    childSnapshots: [snapshot()],
  });
  try {
    const result = await createNekSubagentConversationReader(
      h.adapter,
      2,
    )({ ...params, id: child.id });
    assert.ok(result.rows.length > 2);
    assert.equal(result.totalCount, result.rows.length);
    assert.equal(result.history.turns.length, 1);
    assert.equal(result.history.hasOlder, false);
    assert.equal(result.rows.at(-1)?.kind, "assistantText");
  } finally {
    await h.adapter.dispose();
  }
});

test("S3: a mismatched child file is rejected, never opened as a writable session", async () => {
  const wrong = snapshot();
  wrong.session.id = sessionId;
  const h = harness({
    subagents: [{ ...child, status: "completed" }],
    childSnapshots: [wrong],
    entries: [entry],
  });
  try {
    await assert.rejects(
      h.adapter.getSubagentConversation({ ...params, id: child.id }),
      /different session/,
    );
    assert.equal(h.sessions.length, 1);
  } finally {
    await h.adapter.dispose();
  }
});
