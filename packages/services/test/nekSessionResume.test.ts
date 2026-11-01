import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import {
  command,
  entry,
  harness,
  params,
  sessionId,
  sessionPath,
  target,
} from "./nekSessionHarness.js";

for (const operation of ["subscribe", "read", "send"] as const) {
  test(`SR-1: ${operation} restores a disk-only session through the real service`, async () => {
    const h = harness();
    const frames: ConversationTopicWireCandidate[] = [];
    h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
    try {
      assert.equal(h.adapter.resolveSessionKey(target, sessionId), undefined);
      if (operation === "subscribe") {
        await h.adapter.subscribeConversationV4(params);
        const frame = frames[0];
        assert.ok(frame?.kind === "complete" && frame.frame.payload.kind === "snapshot");
      } else if (operation === "read") await h.adapter.readNekSession(params);
      else await h.adapter.sendNekConversationCommandV4({ target, envelope: command });
      const restored = await h.adapter.readNekSession(params);
      assert.ok(
        restored.rows.window.some((row) => row.kind === "userInput" && row.text === "saved prompt"),
      );
      assert.equal(h.sessions.length, 1);
      if (operation !== "send")
        await h.adapter.sendNekConversationCommandV4({ target, envelope: command });
      assert.ok(h.sessions[0]?.commands.some((cmd) => cmd.type === "prompt"));
    } finally {
      await h.adapter.dispose();
    }
  });
}

test("SR-2: simultaneous subscribe/read/legacy resume share one restore, including identity aliases", async () => {
  const h = harness();
  h.holdSnapshot();
  try {
    const pending = Promise.all([
      h.adapter.subscribeConversationV4(params),
      h.adapter.readNekSession(params),
      h.adapter.resumeSession({ ...params, workspaceIdentity: "same-project" }),
      h.adapter.readSession(params),
    ]);
    h.releaseSnapshot();
    await pending;
    assert.equal(h.sessions.length, 1);
    assert.equal(h.control.commands.filter((cmd) => cmd.type === "list_sessions").length, 1);
    assert.equal(
      h.control.commands.filter((cmd) => cmd.type === "read_session_snapshot").length,
      1,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("SR-3: failed snapshot restore is visible and the same subscription request can retry", async () => {
  const h = harness();
  try {
    h.failSnapshot(new Error("disk is unavailable"));
    await Promise.all([
      assert.rejects(h.adapter.subscribeConversationV4(params), /disk is unavailable/u),
      assert.rejects(h.adapter.readNekSession(params), /disk is unavailable/u),
    ]);
    assert.equal(h.adapter.resolveSessionKey(target, sessionId), undefined);
    assert.equal(
      h.control.commands.filter((cmd) => cmd.type === "read_session_snapshot").length,
      1,
    );
    h.failSnapshot();
    await h.adapter.subscribeConversationV4(params);
    assert.equal(h.sessions.length, 1);
    assert.equal(
      h.control.commands.filter((cmd) => cmd.type === "read_session_snapshot").length,
      2,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("SR-3: failed process initialization is reclaimed instead of being accepted on retry", async () => {
  const h = harness({ failEntries: true });
  try {
    await assert.rejects(h.adapter.readNekSession(params), /entries load failed/u);
    assert.equal(h.adapter.service.listOpenSessions(target.workspacePath).length, 0);
    assert.equal(h.adapter.resolveSessionKey(target, sessionId), undefined);
    await h.adapter.readNekSession(params);
    assert.equal(h.sessions.length, 2);
  } finally {
    await h.adapter.dispose();
  }
});

test("SR-4: a locked disk session is readable but never spawns or admits writes", async () => {
  const holder = {
    pid: 4242,
    hostname: "other-window",
    kind: "rpc" as const,
    startedAt: entry.timestamp,
  };
  const h = harness({ lockedBy: holder });
  try {
    await h.adapter.subscribeConversationV4(params);
    const restored = await h.adapter.readNekSession(params);
    assert.ok(restored.rows.window.some((row) => row.kind === "userInput"));
    const binding = await h.adapter.ensureNekSessionBinding(target, sessionId);
    assert.deepEqual(h.adapter.service.getSession(binding.sessionKey)?.lockHolder, holder);
    await assert.rejects(
      h.adapter.sendNekConversationCommandV4({ target, envelope: command }),
      /read-only/u,
    );
    assert.equal(h.sessions.length, 0);
  } finally {
    await h.adapter.dispose();
  }
});

test("SR-4: explicit legacy resume rechecks a released lock through the same admission", async () => {
  const h = harness({
    lockedBy: { pid: 42, hostname: "nek-terminal", kind: "tui", startedAt: entry.timestamp },
  });
  try {
    await h.adapter.readNekSession(params);
    assert.equal(h.sessions.length, 0);
    h.releaseLock();
    await h.adapter.resumeSession(params);
    const binding = await h.adapter.ensureNekSessionBinding(target, sessionId);
    assert.equal(h.adapter.service.getSession(binding.sessionKey)?.readonly, false);
    assert.equal(h.sessions.length, 1);
    await h.adapter.sendNekConversationCommandV4({ target, envelope: command });
  } finally {
    await h.adapter.dispose();
  }
});

test("SR-5: reconnect after process exit reuses restore admission", async () => {
  const h = harness();
  try {
    await h.adapter.subscribeConversationV4(params);
    await h.sessions[0]?.process.dispose();
    await h.adapter.subscribeConversationV4(params);
    assert.equal(h.sessions.length, 2);
    assert.equal(
      h.control.commands.filter((cmd) => cmd.type === "read_session_snapshot").length,
      2,
    );
    await h.adapter.sendNekConversationCommandV4({ target, envelope: command });
    assert.ok(h.sessions[1]?.commands.some((cmd) => cmd.type === "prompt"));
  } finally {
    await h.adapter.dispose();
  }
});

test("SR-5: closing via a workspace identity alias removes the sole binding", async () => {
  const h = harness();
  try {
    await h.adapter.readNekSession(params);
    await h.adapter.closeNekSession({ ...params, workspaceIdentity: "same-project" });
    assert.equal(h.adapter.resolveSessionKey(target, sessionId), undefined);
    await h.adapter.readNekSession(params);
    assert.equal(h.sessions.length, 2);
  } finally {
    await h.adapter.dispose();
  }
});

test("SR-2: direct service resumes share a path flight", async () => {
  const h = harness();
  h.holdSnapshot();
  try {
    const input = { sessionPath, cwd: target.workspacePath };
    const pending = Promise.all([
      h.adapter.service.resumeSession(input),
      h.adapter.service.resumeSession(input),
    ]);
    h.releaseSnapshot();
    const [first, second] = await pending;
    assert.equal(first.sessionKey, second.sessionKey);
    assert.equal(h.sessions.length, 1);
    assert.equal(
      h.control.commands.filter((cmd) => cmd.type === "read_session_snapshot").length,
      1,
    );
  } finally {
    await h.adapter.dispose();
  }
});
