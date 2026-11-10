import assert from "node:assert/strict";
import test from "node:test";
import type { SessionsIndexTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import { harness, params, sessionId, target } from "./nekSessionHarness.js";

const emptyDraft = {
  id: "empty-draft",
  path: "/sessions/empty.sqlite",
  cwd: target.workspacePath,
  createdAt: "2026-01-01T00:00:01.000Z",
  modifiedAt: "2026-01-01T00:00:01.000Z",
  messageCount: 0,
  firstMessage: "(no messages)",
  locked: false,
};

// 草稿页的预热会话会被 nek 落盘；没有消息时不能以 "(no messages)" 出现在侧栏或会话列表。
test("sessions without messages stay out of both session lists", async () => {
  const h = harness({ extraSessions: [emptyDraft] });
  const frames: SessionsIndexTopicWireCandidate[] = [];
  h.adapter.onDynamicSessionsIndexFrame(target)((frame) => frames.push(frame));
  try {
    const listed = await h.adapter.listSessions(target);
    assert.deepEqual(
      listed.map((session) => session.sessionId),
      [sessionId],
    );
    await h.adapter.subscribeSessionsIndexV4(target);
    const frame = frames.at(-1);
    assert.ok(frame?.kind === "complete" && frame.frame.payload.kind === "snapshot");
    assert.deepEqual(
      frame.frame.payload.snapshot.sessions.map((session) => session.sessionId),
      [sessionId],
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("GU-2: sessions-index publishes live running and stopped phases for the upstream sidebar spinner", async () => {
  const h = harness();
  const frames: SessionsIndexTopicWireCandidate[] = [];
  h.adapter.onDynamicSessionsIndexFrame(target)((frame) => frames.push(frame));
  const latest = () => {
    const frame = frames.at(-1);
    assert.ok(frame?.kind === "complete" && frame.frame.payload.kind === "snapshot");
    return frame.frame.payload.snapshot.sessions.find((session) => session.sessionId === sessionId);
  };
  try {
    await h.adapter.subscribeConversationV4(params);
    await h.adapter.subscribeSessionsIndexV4(target);
    assert.equal(latest()?.phase, "completedSuccess");
    h.sessions[0]!.emit({ type: "agent_start" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(latest()?.phase, "running");
    assert.equal(latest()?.sessionEnded, false);
    h.sessions[0]!.emit({ type: "agent_settled", outcome: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(latest()?.phase, "running");
    assert.equal(latest()?.sessionEnded, true);
  } finally {
    await h.adapter.dispose();
  }
});

// nek 拒绝删除被活进程锁住的会话：必须先关闭会话进程再删除，否则预热会话与已打开任务都删不掉。
test("deleting an open session closes its process before nek deletes the file", async () => {
  const h = harness();
  try {
    await h.adapter.subscribeConversationV4(params);
    const session = h.sessions[0];
    assert.ok(session && !session.isDisposed(), "subscribing opens a session process");
    const ack = await h.adapter.sendNekConversationCommandV4({
      target,
      envelope: {
        commandId: "delete",
        clientId: "test",
        sessionId,
        type: "deleteSession",
        payload: {},
        issuedAt: 1,
      },
    });
    assert.equal(ack.status, "accepted");
    assert.ok(session.isDisposed());
    assert.ok(h.control.commands.some((command) => command.type === "delete_session"));
    assert.equal(h.adapter.resolveSessionKey(target, sessionId), undefined);
  } finally {
    await h.adapter.dispose();
  }
});
