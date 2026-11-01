import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { NekGuiInfo, NekRpcCommand, NekSessionSnapshot } from "@zcode/shared/nek-protocol";
import type { ConversationTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import { createNekAgentServiceAdapter } from "../src/nek-agent/adapter/index.js";
import { NekRpcClient, type NekRpcProcessExit } from "../src/nek-agent/nekRpcClient.js";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";

const target = { workspacePath: "/project" };
const sessionId = "disk-session";
const sessionPath = "/sessions/disk.jsonl";
const guiInfo: NekGuiInfo = {
  protocolVersion: 1,
  nekVersion: "test",
  piVersion: "test",
  node: { path: process.execPath, version: process.versions.node },
  launch: { args: [] },
  agentDir: "/isolated-agent",
  sessionDir: "/sessions",
  platform: "linux",
  arch: "x64",
};
const entry = {
  id: "user-1",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  type: "message" as const,
  message: { role: "user" as const, content: "saved prompt", timestamp: 1 },
};
const summary = {
  id: sessionId,
  path: sessionPath,
  cwd: target.workspacePath,
  createdAt: entry.timestamp,
  modifiedAt: entry.timestamp,
  messageCount: 1,
  firstMessage: "saved prompt",
  locked: false,
};

/** In-memory JSONL transport; the real adapter, service, pool and projector remain in the test. */
function createProcess(reply: (command: NekRpcCommand) => unknown | Promise<unknown>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const exits = new Set<(exit: NekRpcProcessExit) => void>();
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const command = JSON.parse(line) as NekRpcCommand & { id?: string };
      commands.push(command);
      if (!command.id) continue;
      void Promise.resolve()
        .then(() => reply(command))
        .then(
          (data) =>
            stdout.write(
              `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })}\n`,
            ),
          (error: unknown) =>
            stdout.write(
              `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: error instanceof Error ? error.message : String(error) })}\n`,
            ),
        );
    }
  });
  const handle = {
    stdin,
    stdout,
    stderr,
    onExit: (listener: (exit: NekRpcProcessExit) => void) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    kill: () => {
      for (const listener of exits) listener({ code: 0, signal: null });
    },
  };
  const client = new NekRpcClient(handle, { defaultTimeoutMs: 1_000 });
  const process: NekRpcProcess = {
    client,
    guiInfo,
    exitInfo: () => undefined,
    onExit: (listener) => handle.onExit(listener),
    dispose: async () => {
      handle.kill();
      await client.close();
    },
  };
  return { process, commands };
}

function harness(
  options: { lockedBy?: NekSessionSnapshot["lockedBy"]; failEntries?: boolean } = {},
) {
  let failEntries = options.failEntries ?? false;
  let snapshotFailure: Error | undefined;
  let release: (() => void) | undefined;
  let barrier: Promise<void> | undefined;
  const snapshot: NekSessionSnapshot = {
    session: { ...summary, locked: !!options.lockedBy },
    lockedBy: options.lockedBy,
    entries: [entry],
    messages: [entry.message],
    leafId: entry.id,
  };
  const control = createProcess(async (command) => {
    if (command.type === "list_sessions") return { sessions: [snapshot.session] };
    if (command.type === "read_session_snapshot") {
      await barrier;
      if (snapshotFailure) throw snapshotFailure;
      return snapshot;
    }
    if (command.type === "get_project_trust")
      return {
        cwd: target.workspacePath,
        trusted: true,
        defaultProjectTrust: "always",
        resources: [],
      };
    return {};
  });
  const sessions: ReturnType<typeof createProcess>[] = [];
  const adapter = createNekAgentServiceAdapter({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      assert.equal(request.sessionPath, sessionPath);
      const session = createProcess((command) => {
        if (command.type === "get_state")
          return {
            sessionId,
            sessionFile: sessionPath,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "all",
            followUpMode: "one-at-a-time",
            autoCompactionEnabled: true,
            messageCount: 1,
            pendingMessageCount: 0,
          };
        if (command.type === "get_entries") {
          if (failEntries) {
            failEntries = false;
            throw new Error("entries load failed");
          }
          return { entries: [entry], leafId: entry.id };
        }
        if (command.type === "get_session_stats")
          return {
            sessionId,
            sessionFile: sessionPath,
            userMessages: 1,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 1,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
          };
        if (command.type === "extension_call")
          return { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
        if (command.type === "prompt") return { disposition: "started" };
        return {};
      });
      sessions.push(session);
      return session.process;
    },
  });
  return {
    adapter,
    sessions,
    control,
    failSnapshot: (error?: Error) => {
      snapshotFailure = error;
    },
    holdSnapshot: () => {
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    releaseSnapshot: () => release?.(),
    releaseLock: () => {
      snapshot.session.locked = false;
      delete snapshot.lockedBy;
    },
  };
}

const params = { ...target, sessionId };
const command = {
  commandId: "continued",
  clientId: "test",
  sessionId,
  type: "sendText",
  payload: { text: "continue" },
  issuedAt: 1,
};

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
