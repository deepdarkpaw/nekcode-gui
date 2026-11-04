import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { NekGuiInfo, NekRpcCommand, NekSessionSnapshot } from "@zcode/shared/nek-protocol";
import type { NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "../src/nek-agent/nekRpcClient.js";
import type { NekExtensionUiHandler } from "../src/nek-agent/nekExtensionUiRouter.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import { NekProcessPool } from "../src/nek-agent/nekProcessPool.js";
import { NekAgentService } from "../src/nek-agent/service/nekAgentService.js";
import { createNekAgentRuntimeLifecycle } from "../src/nek-agent/adapter/nekAgentRuntimeLifecycle.js";
import type { NekAgentServiceEvent } from "../src/nek-agent/service/types.js";

const guiInfo = {
  protocolVersion: 1,
  nekVersion: "test",
  piVersion: "test",
  node: { path: process.execPath, version: process.versions.node },
  launch: { args: [] },
  agentDir: "/tmp/agent",
  sessionDir: "/tmp/sessions",
  platform: "linux",
  arch: "x64",
} satisfies NekGuiInfo;

const model = {
  provider: "acme",
  modelId: "acme-1",
  name: "Acme One",
  contextWindow: 128_000,
  maxTokens: 8_192,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const stats = {
  sessionFile: "/tmp/session.jsonl",
  sessionId: "s1",
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

function state(sessionFile = "/tmp/session.jsonl", streaming = false) {
  return {
    model: undefined,
    thinkingLevel: "medium" as const,
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: "all" as const,
    followUpMode: "one-at-a-time" as const,
    sessionFile,
    sessionId: "s1",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

function snapshot(locked: boolean, lockedBy?: NekSessionSnapshot["lockedBy"]): NekSessionSnapshot {
  return {
    session: {
      path: "/tmp/session.jsonl",
      id: "s1",
      cwd: "/workspace",
      createdAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 0,
      firstMessage: "",
      locked,
    },
    entries: [],
    leafId: null,
    messages: [],
    ...(lockedBy ? { lockedBy } : {}),
  };
}

interface FakeProcess {
  process: NekRpcProcess;
  commands: NekRpcCommand[];
  emit(record: unknown): void;
  exit(info?: Partial<NekRpcProcessExit>): void;
  setSnapshotLocked(locked: boolean): void;
}

function fakeProcess(
  kind: "control" | "session",
  sessionFile = "/tmp/session.jsonl",
  extensionUi?: NekExtensionUiHandler,
  lockHolder?: NekSessionSnapshot["lockedBy"],
  projectTrust: { trusted: boolean | null; defaultProjectTrust: "ask" | "always" | "never" } = {
    trusted: null,
    defaultProjectTrust: "ask",
  },
): FakeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const exits = new Set<(info: NekRpcProcessExit) => void>();
  let exited = false;
  let streaming = false;
  let snapshotLocked = true;
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    while (true) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const command = JSON.parse(line) as NekRpcCommand & { id?: string };
      if (command.type === "extension_ui_response") continue;
      commands.push(command);
      if (!command.id) continue;
      let data: unknown;
      if (kind === "control") {
        if (command.type === "get_project_trust") {
          data = { cwd: command.cwd, ...projectTrust, resources: [] };
        } else if (command.type === "read_session_snapshot") {
          data = snapshot(snapshotLocked, lockHolder);
        } else if (command.type === "list_sessions") {
          data = { sessions: [] };
        } else if (command.type === "get_mention_targets") {
          data = { targets: [{ kind: "skill", name: "pdf" }] };
        } else if (command.type === "import_session") {
          data = { sessionPath: command.inputPath };
        } else {
          data = {};
        }
      } else if (command.type === "get_state") {
        data = state(sessionFile, streaming);
      } else if (command.type === "get_entries") {
        data = { entries: [], leafId: null, hasMore: command.limit !== undefined };
      } else if (command.type === "get_session_stats") {
        data = { ...stats, sessionFile, sessionId: "s1" };
      } else if (command.type === "extension_call") {
        data = { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
      } else if (command.type === "prompt") {
        streaming = true;
        data = { disposition: "started" };
      } else if (command.type === "steer" || command.type === "follow_up") {
        data = { disposition: "queued" };
      } else if (command.type === "bash") {
        data = { output: "ok", exitCode: 0, cancelled: false, truncated: false };
      } else if (command.type === "clear_queue") {
        data = { steering: ["steer me"], followUp: ["later"] };
      } else if (command.type === "compact") {
        data = { summary: "compacted", firstKeptEntryId: "e2", tokensBefore: 900 };
      } else if (command.type === "set_model") {
        data = model;
      } else if (command.type === "cycle_model") {
        data = { model, thinkingLevel: "low", isScoped: false };
      } else if (command.type === "set_thinking_level") {
        data = undefined;
      } else if (command.type === "cycle_thinking_level") {
        data = { level: "low" };
      } else if (command.type === "get_commands") {
        data = {
          commands: [
            {
              name: "compact",
              source: "extension",
              sourceInfo: { path: "/c", source: "s", scope: "user", origin: "package" },
            },
          ],
        };
      } else if (command.type === "get_tree") {
        data = { tree: [], leafId: null };
      } else if (command.type === "get_fork_messages") {
        data = { messages: [{ entryId: "e1", text: "first" }] };
      } else if (command.type === "get_mention_targets") {
        data = { targets: [{ kind: "agent", name: "explorer" }] };
      } else if (command.type === "navigate_tree") {
        data = { cancelled: false, editorText: "restored" };
      } else if (command.type === "set_entry_label") {
        data = {};
      } else if (command.type === "fork") {
        data = { text: "forked", cancelled: false };
      } else if (command.type === "clone") {
        data = { cancelled: false };
      } else if (command.type === "export_session") {
        data = { path: "/tmp/out.html" };
      } else if (command.type === "share_session") {
        data = { url: "https://share.test/session" };
      } else if (command.type === "reload") {
        data = { deferred: false, diagnostics: [] };
      } else if (command.type === "abort_bash") {
        data = undefined;
      } else {
        data = {};
      }
      stdout.write(
        `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data })}\n`,
      );
    }
  });
  const handle: NekRpcProcessHandle = {
    stdin,
    stdout,
    stderr,
    kill: () => emitExit({ code: null, signal: "SIGKILL" }),
    onExit: (listener) => {
      exits.add(listener);
      return () => exits.delete(listener);
    },
  };
  const client = new NekRpcClient(handle, { defaultTimeoutMs: 500, extensionUi });
  const emitExit = (info: NekRpcProcessExit) => {
    if (exited) return;
    exited = true;
    for (const listener of exits) listener(info);
  };
  return {
    process: {
      client,
      guiInfo,
      pid: 42,
      exitInfo: () => undefined,
      onExit: (listener) => handle.onExit(() => listener()),
      dispose: async () => {
        if (!exited) emitExit({ code: 0, signal: null });
        await client.close();
      },
    },
    commands,
    setSnapshotLocked: (locked) => {
      snapshotLocked = locked;
    },
    emit: (record) => stdout.write(`${JSON.stringify(record)}\n`),
    exit: (info = {}) => emitExit({ code: info.code ?? 1, signal: info.signal ?? null, ...info }),
  };
}

function serviceHarness(
  extensionUi?: NekExtensionUiHandler,
  lockHolder?: NekSessionSnapshot["lockedBy"],
  askProjectTrust: () => boolean = () => true,
  projectTrust?: { trusted: boolean | null; defaultProjectTrust: "ask" | "always" | "never" },
) {
  const control = fakeProcess("control", "/tmp/session.jsonl", undefined, lockHolder, projectTrust);
  const sessions: FakeProcess[] = [];
  const approvals: boolean[] = [];
  const service = new NekAgentService({
    guiInfo,
    askProjectTrust,
    extensionUi,
    createControlProcess: () => control.process,
    createSessionProcess: (options) => {
      approvals.push(options.approve === true);
      const process = fakeProcess(
        "session",
        options.sessionPath ?? "/tmp/session.jsonl",
        options.extensionUi,
      );
      sessions.push(process);
      return process.process;
    },
  });
  return { service, control, sessions, approvals };
}

test("creates a session after project trust approval and passes --approve", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  assert.equal(result.sessionId, "s1");
  assert.equal(result.readonly, false);
  assert.deepEqual(harness.approvals, [true]);
  assert.deepEqual(
    harness.control.commands.map((command) => command.type),
    ["get_project_trust", "set_project_trust"],
  );
  await harness.service.dispose();
});

test("opens an already trusted project without prompting or rewriting trust", async () => {
  const harness = serviceHarness(
    undefined,
    undefined,
    () => {
      throw new Error("already trusted projects must not prompt");
    },
    { trusted: true, defaultProjectTrust: "ask" },
  );
  const result = await harness.service.createSession({ cwd: "/workspace" });
  assert.equal(result.readonly, false);
  assert.deepEqual(
    harness.control.commands.map((command) => command.type),
    ["get_project_trust"],
  );
  await harness.service.dispose();
});

test("rejects an untrusted project visibly and allows a later retry", async () => {
  let approved = false;
  const harness = serviceHarness(undefined, undefined, () => approved);
  await assert.rejects(
    harness.service.createSession({ cwd: "/workspace" }),
    /project trust denied.*confirm trust and retry/u,
  );
  assert.equal(harness.sessions.length, 0);
  approved = true;
  const result = await harness.service.createSession({ cwd: "/workspace" });
  assert.equal(result.readonly, false);
  assert.deepEqual(
    harness.control.commands.map((command) => command.type),
    ["get_project_trust", "get_project_trust", "set_project_trust"],
  );
  await harness.service.dispose();
});

test("opens a locked session from a read-only snapshot", async () => {
  const harness = serviceHarness();
  const result = await harness.service.resumeSession({ sessionPath: "/tmp/session.jsonl" });
  assert.equal(result.readonly, true);
  assert.equal(result.phase, "locked");
  // 早于 P2c 的 nek 不报持有者：只记下"被占用"。
  assert.equal(result.lockedBy, "nek");
  assert.equal(result.lockHolder, undefined);
  assert.equal(harness.sessions.length, 0);
  await harness.service.dispose();
});

test("reports the lock holder nek names in a read-only snapshot", async () => {
  const lockHolder = {
    pid: 4242,
    hostname: "dev-box",
    kind: "tui" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  const harness = serviceHarness(undefined, lockHolder);
  const result = await harness.service.resumeSession({ sessionPath: "/tmp/session.jsonl" });
  assert.equal(result.phase, "locked");
  assert.deepEqual(result.lockHolder, lockHolder);
  assert.equal(result.lockedBy, "nek tui (dev-box:4242)");
  assert.deepEqual(result.snapshot?.lockedBy, lockHolder);
  // 只读拒绝仍然指明占用者。
  await assert.rejects(
    async () => await harness.service.sendPrompt({ sessionKey: result.sessionKey, message: "hi" }),
    /is read-only \(nek tui \(dev-box:4242\)\)/,
  );
  await harness.service.dispose();
});

test("chooses prompt while idle and steer/follow_up while running, then aborts", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  const key = result.sessionKey;
  await harness.service.sendPrompt({ sessionKey: key, message: "hello" });
  harness.sessions[0]!.emit({ type: "agent_start" });
  await harness.service.sendPrompt({ sessionKey: key, message: "now", streamingBehavior: "steer" });
  await harness.service.sendPrompt({
    sessionKey: key,
    message: "later",
    streamingBehavior: "followUp",
  });
  await harness.service.abort(key);
  assert.deepEqual(
    harness.sessions[0]!.commands.map((command) => command.type),
    [
      "get_state",
      "get_state",
      "get_entries",
      "get_session_stats",
      "extension_call",
      "prompt",
      "steer",
      "follow_up",
      "abort",
    ],
  );
  await harness.service.dispose();
});

test("shares one projector for subscribers and replays a snapshot on resubscribe", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  const first: unknown[] = [];
  const second: unknown[] = [];
  await harness.service.subscribeConversation(result.sessionKey, (frame) => first.push(frame));
  await harness.service.subscribeConversation(result.sessionKey, (frame) => second.push(frame));
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  harness.sessions[0]!.emit({
    type: "message_start",
    message: { role: "user", content: "hi", timestamp: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(first.length >= 2);
  assert.ok(second.length >= 2);
  const third: unknown[] = [];
  await harness.service.subscribeConversation(result.sessionKey, (frame) => third.push(frame));
  assert.equal(third.length, 1);
  assert.equal((third[0] as { payload: { kind: string } }).payload.kind, "snapshot");
  await harness.service.dispose();
});

test("enters error on an unexpected exit and can restart", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  harness.sessions[0]!.exit({ code: 2 });
  assert.equal(harness.service.getSession(result.sessionKey)?.phase, "error");
  harness.control.setSnapshotLocked(false);
  const restarted = await harness.service.restartSession(result.sessionKey);
  assert.equal(restarted.phase, "idle");
  assert.equal(harness.sessions.length, 2);
  await harness.service.dispose();
});

test("reopening after a crash mid-turn stays idle, as nek discards the interrupted run", async () => {
  const harness = serviceHarness();
  const phases: string[] = [];
  const detach = harness.service.onEvent((event: NekAgentServiceEvent) => {
    if (event.type === "state") phases.push(event.state);
  });
  try {
    const created = await harness.service.createSession({ cwd: "/workspace" });
    await harness.service.sendPrompt({ sessionKey: created.sessionKey, message: "long task" });
    harness.sessions[0]!.emit({ type: "agent_start" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.service.getSession(created.sessionKey)?.phase, "running");
    harness.sessions[0]!.exit({ code: null, signal: "SIGKILL" });
    harness.control.setSnapshotLocked(false);
    phases.length = 0;

    // nek ≥0.4.1 先中止上次留下的回合再应答 get_state：新进程报告 isStreaming=false。
    const reopened = await harness.service.restartSession(created.sessionKey);
    assert.equal(reopened.phase, "idle");
    assert.equal(harness.sessions.length, 2);
    assert.ok(!phases.includes("running"), `unexpected phases: ${phases.join(",")}`);
    assert.ok(
      !harness.sessions[1]!.commands.some((command) => command.type === "prompt"),
      "重开不重发上次的请求",
    );
  } finally {
    detach();
    await harness.service.dispose();
  }
});

test("SR-4: restart rechecks the external lock instead of forcing a writable process", async () => {
  const holder = {
    pid: 4242,
    hostname: "other-process",
    kind: "tui" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  const harness = serviceHarness(undefined, holder);
  try {
    const created = await harness.service.createSession({ cwd: "/workspace" });
    harness.sessions[0]!.exit({ code: 2 });
    const restarted = await harness.service.restartSession(created.sessionKey);
    assert.equal(restarted.readonly, true);
    assert.deepEqual(restarted.lockHolder, holder);
    assert.equal(harness.sessions.length, 1);
  } finally {
    await harness.service.dispose();
  }
});

test("routes structured UI and cancels it through the injected router", async () => {
  let cancelled = false;
  const harness = serviceHarness({
    structured: (_request, signal) =>
      new Promise<undefined>((resolve) => {
        signal.addEventListener("abort", () => {
          cancelled = true;
          resolve(undefined);
        });
      }),
  });
  const result = await harness.service.createSession({ cwd: "/workspace" });
  harness.sessions[0]!.emit({
    type: "extension_ui_request",
    id: "structured-1",
    method: "structured",
    kind: "nek.ask_question",
    payload: { questions: [] },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  harness.sessions[0]!.emit({ type: "extension_ui_cancel", id: "structured-1" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelled, true);
  await harness.service.closeSession(result.sessionKey);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function commandTypes(harness: ReturnType<typeof serviceHarness>, index = 0): string[] {
  return harness.sessions[index]!.commands.map((command) => command.type);
}

test("runs an excluded bash command and aborts the running one", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  const bashResult = await harness.service.bash({
    sessionKey: result.sessionKey,
    command: "ls",
    excludeFromContext: true,
  });
  assert.equal(bashResult.output, "ok");
  await harness.service.abortBash(result.sessionKey);

  const bash = harness.sessions[0]!.commands.find((command) => command.type === "bash");
  assert.equal((bash as { excludeFromContext?: boolean }).excludeFromContext, true);
  assert.deepEqual(commandTypes(harness).slice(-2), ["bash", "abort_bash"]);
  await harness.service.dispose();
});

test("compacts with custom instructions", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });
  const compacted = await harness.service.compact({
    sessionKey: result.sessionKey,
    instructions: "keep the decisions",
  });
  assert.equal(compacted.summary, "compacted");
  const compact = harness.sessions[0]!.commands.find((command) => command.type === "compact");
  assert.equal(
    (compact as { customInstructions?: string }).customInstructions,
    "keep the decisions",
  );
  await harness.service.dispose();
});

test("sets the collaboration mode through extension_call nek.set_mode", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace", mode: "plan" });
  await harness.service.setMode({ sessionKey: result.sessionKey, mode: "agent" });

  const modeCalls = harness.sessions[0]!.commands.filter(
    (command) => command.type === "extension_call" && command.method === "nek.set_mode",
  );
  assert.deepEqual(
    modeCalls.map((command) => command.params),
    [{ mode: "plan" }, { mode: "agent" }],
  );
  assert.equal(
    harness.sessions[0]!.commands.some(
      (command) => (command as { type: string }).type === "set_mode",
    ),
    false,
    "nek 没有独立的 set_mode 命令",
  );
  await harness.service.dispose();
});

test("forks, clones and reads the entries needed to pick a fork point", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  const entries = await harness.service.getEntries({ sessionKey: result.sessionKey });
  assert.deepEqual(entries, { entries: [], leafId: null, hasMore: false });
  assert.deepEqual((await harness.service.getTree(result.sessionKey)).tree, []);
  assert.deepEqual(await harness.service.getForkMessages(result.sessionKey), [
    { entryId: "e1", text: "first" },
  ]);

  assert.deepEqual(await harness.service.fork({ sessionKey: result.sessionKey, entryId: "e1" }), {
    text: "forked",
    cancelled: false,
  });
  assert.deepEqual(await harness.service.clone(result.sessionKey), { cancelled: false });

  const fork = harness.sessions[0]!.commands.find((command) => command.type === "fork");
  assert.equal((fork as { entryId: string }).entryId, "e1");
  assert.deepEqual(commandTypes(harness).slice(-2), ["fork", "clone"]);
  await harness.service.dispose();
});

test("pages session entries with limit and beforeEntryId", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  const page = await harness.service.getEntries({
    sessionKey: result.sessionKey,
    limit: 2,
    beforeEntryId: "e9",
  });
  assert.equal(page.hasMore, true, "nek says whether entries older than the page exist");
  const call = harness.sessions[0]!.commands.at(-1) as {
    type: string;
    limit?: number;
    beforeEntryId?: string;
    since?: string;
  };
  assert.equal(call.type, "get_entries");
  assert.equal(call.limit, 2);
  assert.equal(call.beforeEntryId, "e9");
  assert.equal(call.since, undefined);

  // 不带分页参数时不额外发字段：请求仍然是"整份列表"。
  await harness.service.getEntries({ sessionKey: result.sessionKey, since: "e1" });
  const sinceCall = harness.sessions[0]!.commands.at(-1) as {
    type: string;
    limit?: number;
    beforeEntryId?: string;
    since?: string;
  };
  assert.equal(sinceCall.type, "get_entries");
  assert.equal(sinceCall.since, "e1");
  assert.equal(sinceCall.limit, undefined);
  assert.equal(sinceCall.beforeEntryId, undefined);
  await harness.service.dispose();
});

test("exports, shares and imports sessions", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  assert.deepEqual(
    await harness.service.exportSession({
      sessionKey: result.sessionKey,
      format: "html",
      outputPath: "/tmp/out.html",
    }),
    { path: "/tmp/out.html" },
  );
  assert.deepEqual(await harness.service.shareSession(result.sessionKey), {
    url: "https://share.test/session",
  });
  assert.deepEqual(
    await harness.service.importSession({ inputPath: "/tmp/in.jsonl", cwd: "/workspace" }),
    { sessionPath: "/tmp/in.jsonl" },
  );

  const exported = harness.sessions[0]!.commands.find(
    (command) => command.type === "export_session",
  );
  assert.deepEqual(
    { format: exported?.format, outputPath: exported?.outputPath },
    { format: "html", outputPath: "/tmp/out.html" },
  );
  await harness.service.dispose();
});

test("switches model and thinking, then reads stats, commands and reloads", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  const selected = await harness.service.setModel({
    sessionKey: result.sessionKey,
    provider: "acme",
    modelId: "acme-1",
  });
  assert.equal(selected.modelId, "acme-1");
  assert.deepEqual(await harness.service.cycleModel(result.sessionKey), {
    model,
    thinkingLevel: "low",
    isScoped: false,
  });
  await harness.service.setThinkingLevel({ sessionKey: result.sessionKey, level: "high" });
  assert.deepEqual(await harness.service.cycleThinkingLevel(result.sessionKey), { level: "low" });
  assert.equal((await harness.service.getStats(result.sessionKey)).sessionId, "s1");
  assert.deepEqual(await harness.service.getCommands(result.sessionKey), [
    {
      name: "compact",
      source: "extension",
      sourceInfo: { path: "/c", source: "s", scope: "user", origin: "package" },
    },
  ]);
  assert.deepEqual(await harness.service.reload(result.sessionKey), {
    deferred: false,
    diagnostics: [],
  });

  assert.deepEqual(commandTypes(harness).slice(-7), [
    "set_model",
    "cycle_model",
    "set_thinking_level",
    "cycle_thinking_level",
    "get_session_stats",
    "get_commands",
    "reload",
  ]);
  await harness.service.dispose();
});

test("navigates the tree and labels an entry", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  const navigated = await harness.service.navigateTree({
    sessionKey: result.sessionKey,
    entryId: "e1",
    summarize: true,
    customInstructions: "summarize it",
    replaceInstructions: false,
    label: "after fork",
  });
  assert.deepEqual(navigated, { cancelled: false, editorText: "restored" });
  await harness.service.setEntryLabel({
    sessionKey: result.sessionKey,
    entryId: "e1",
    label: "kept",
  });

  const navigate = harness.sessions[0]!.commands.find(
    (command) => command.type === "navigate_tree",
  );
  assert.deepEqual(
    {
      entryId: navigate?.entryId,
      summarize: navigate?.summarize,
      customInstructions: navigate?.customInstructions,
      label: navigate?.label,
    },
    { entryId: "e1", summarize: true, customInstructions: "summarize it", label: "after fork" },
  );
  const labelled = harness.sessions[0]!.commands.find(
    (command) => command.type === "set_entry_label",
  );
  assert.deepEqual(
    { entryId: labelled?.entryId, label: labelled?.label },
    { entryId: "e1", label: "kept" },
  );
  await harness.service.dispose();
});

test("clears and retrieves the queued input", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  assert.deepEqual(await harness.service.clearQueue(result.sessionKey), {
    steering: ["steer me"],
    followUp: ["later"],
  });
  assert.deepEqual(await harness.service.retrieveQueue(result.sessionKey), {
    steering: ["steer me"],
    followUp: ["later"],
  });
  assert.deepEqual(commandTypes(harness).slice(-2), ["clear_queue", "clear_queue"]);
  await harness.service.dispose();
});

test("resolves mention targets from the session process or the control process", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  assert.deepEqual(await harness.service.getMentionTargets({ sessionKey: result.sessionKey }), [
    { kind: "agent", name: "explorer" },
  ]);
  assert.deepEqual(await harness.service.getMentionTargets({ cwd: "/workspace" }), [
    { kind: "skill", name: "pdf" },
  ]);
  assert.ok(commandTypes(harness).includes("get_mention_targets"));
  assert.ok(harness.control.commands.some((command) => command.type === "get_mention_targets"));
  await harness.service.dispose();
});

test("refuses write commands on a read-only snapshot", async () => {
  const harness = serviceHarness();
  const result = await harness.service.resumeSession({ sessionPath: "/tmp/session.jsonl" });
  await assert.rejects(
    harness.service.bash({ sessionKey: result.sessionKey, command: "ls" }),
    /read-only/u,
  );
  await assert.rejects(
    harness.service.sendPrompt({ sessionKey: result.sessionKey, message: "hi" }),
    /read-only/u,
  );
  await harness.service.dispose();
});

test("lists, renames and deletes sessions through the control process", async () => {
  const harness = serviceHarness();
  const result = await harness.service.createSession({ cwd: "/workspace" });

  assert.deepEqual(await harness.service.listSessions({ cwd: "/workspace", all: true }), []);
  await harness.service.renameSession({ sessionKey: result.sessionKey, name: "renamed" });
  await harness.service.deleteSession({ sessionKey: result.sessionKey });

  assert.deepEqual(
    harness.control.commands
      .map((command) => command.type)
      .filter((type) => type !== "get_project_trust" && type !== "set_project_trust"),
    ["list_sessions", "rename_session", "delete_session"],
  );
  assert.equal(harness.service.getSession(result.sessionKey), undefined, "删除后不再持有记录");
  await harness.service.dispose();
});

test("reopens a session process reclaimed by the idle sweep", async () => {
  const control = fakeProcess("control");
  const sessions: FakeProcess[] = [];
  const pool = new NekProcessPool<NekRpcProcess>({
    maxSessions: 4,
    idleTimeoutMs: 30,
    createSessionProcess: async () => {
      const process = fakeProcess("session", "/tmp/session.jsonl");
      sessions.push(process);
      return process.process;
    },
    createControlProcess: async () => control.process,
  });
  const service = new NekAgentService({ guiInfo, processPool: pool, askProjectTrust: () => true });
  try {
    const result = await service.createSession({ cwd: "/workspace" });
    assert.equal(sessions.length, 1);
    await sleep(150);
    const reclaimed = service.getSession(result.sessionKey);
    assert.equal(reclaimed?.phase, "idle", "池回收空闲进程不是错误状态");
    assert.equal(reclaimed?.processId, undefined);
    await service.getStats(result.sessionKey);
    assert.equal(sessions.length, 2, "下一条命令按同一会话文件重连");
  } finally {
    await service.dispose();
  }
});

test("process_attached 只在记录登记之后发出，订阅者当下就能查到活会话", async () => {
  const harness = serviceHarness();
  const observed: { sessionKey: string; live: boolean; open: number; processId?: number }[] = [];
  const detach = harness.service.onEvent((event: NekAgentServiceEvent) => {
    if (event.type !== "process_attached") return;
    // 同步监听者看到的是已经登记的记录与已挂接的进程，不是半初始化的快照。
    assert.ok(harness.service.getSession(event.session.sessionKey));
    observed.push({
      sessionKey: event.session.sessionKey,
      live: harness.service.hasLiveSessionProcess(event.session.cwd),
      open: harness.service.listOpenSessions(event.session.cwd).length,
      ...(event.session.processId ? { processId: event.session.processId } : {}),
    });
  });
  try {
    const created = await harness.service.createSession({ cwd: "/workspace" });
    assert.deepEqual(observed, [
      { sessionKey: created.sessionKey, live: true, open: 1, processId: 42 },
    ]);
    assert.equal(harness.service.hasLiveSessionProcess("/workspace"), true);
  } finally {
    detach();
    await harness.service.dispose();
  }
});

test("真实 service：正常关闭不换代，崩溃后重新挂进程才换代", async () => {
  const harness = serviceHarness();
  const lifecycle = createNekAgentRuntimeLifecycle(harness.service);
  const frames: [string, number][] = [];
  const subscription = lifecycle.onDidChange((event) =>
    frames.push([event.state, event.runtimeIdentity.generation]),
  );
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const created = await harness.service.createSession({ cwd: "/workspace" });
    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.[0], "available");
    const firstGeneration = frames[0]?.[1] ?? 0;
    assert.equal(lifecycle.getIdentity("/workspace").generation, firstGeneration);

    // 正常关闭：不是错误恢复，帧流不会断，不发 unavailable。
    await harness.service.closeSession(created.sessionKey);
    await sleep(20);
    assert.deepEqual(frames, [["available", firstGeneration]]);
    assert.equal(harness.service.hasLiveSessionProcess("/workspace"), false);

    // 重新打开同一 workspace：仍是同一代，观察者不必重订阅。
    const reopened = await harness.service.createSession({ cwd: "/workspace" });
    await sleep(20);
    assert.deepEqual(frames, [["available", firstGeneration]]);

    // 进程崩溃：最后一条存活进程消失，才发 unavailable（携带被淘汰的那一代）。
    harness.sessions.at(-1)!.exit();
    await sleep(20);
    assert.deepEqual(frames, [
      ["available", firstGeneration],
      ["unavailable", firstGeneration],
    ]);
    assert.equal(harness.service.hasLiveSessionProcess("/workspace"), false);

    // 下一次命令按同一会话文件重连：新进程挂上即恢复，代际前进。
    await harness.service.getStats(reopened.sessionKey);
    await sleep(20);
    assert.equal(frames.length, 3);
    assert.equal(frames[2]?.[0], "available");
    assert.ok((frames[2]?.[1] ?? 0) > firstGeneration);
    assert.equal(lifecycle.getIdentity("/workspace").generation, frames[2]?.[1]);
    assert.equal(harness.service.hasLiveSessionProcess("/workspace"), true);
  } finally {
    subscription.dispose();
    await harness.service.dispose();
  }
});
