import { fixtureHistory } from "./nekHistoryFixture.js";
import { createHistoryStream, historyStreamCapabilities } from "./nekHistoryStreamFixture.js";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { dirname } from "node:path";
import type {
  NekGuiInfo,
  NekInteractionFrame,
  NekProjectTrust,
  NekProjectTrustChoice,
  NekRpcCommand,
} from "@zcode/shared/nek-protocol";
import { buildNekRpcArgs, type NekRpcProcess } from "../src/nek-agent/nekRpcProcess.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "../src/nek-agent/nekRpcClient.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import { NekAgentInteractionChannel } from "../src/nek-agent/adapter/nekAgentInteractionChannel.js";
import { NekGuiInteractionBridge } from "../src/nek-agent/service/guiInteractionBridge.js";
import { NekAgentService } from "../src/nek-agent/service/nekAgentService.js";
import type { NekExtensionUiHandler } from "../src/nek-agent/nekExtensionUiRouter.js";
import type { NekAgentServiceOptions } from "../src/nek-agent/service/types.js";

const guiInfo = {
  protocolVersion: 1,
  capabilities: historyStreamCapabilities,
  nekVersion: "test",
  piVersion: "test",
  node: { path: process.execPath, version: process.versions.node },
  launch: { args: [] },
  agentDir: "/tmp/agent",
  sessionDir: "/tmp/sessions",
  platform: "linux",
  arch: "x64",
} satisfies NekGuiInfo;

interface FakeProcess {
  process: NekRpcProcess;
  commands: NekRpcCommand[];
  responses: unknown[];
  /** 模拟 nek 主动发出的 stdout 事件（extension_ui_request / extension_ui_cancel）。 */
  emit(record: unknown): void;
}

const CWD = "/workspace";
const DEFAULT_TRUST = {
  trusted: null,
  defaultProjectTrust: "ask",
  resources: [{ kind: "settings", path: `${CWD}/.nek/settings.json` }],
} satisfies Omit<NekProjectTrust, "cwd">;

type TrustFixture = Partial<Omit<NekProjectTrust, "cwd" | "trusted">> & {
  decisions?: Map<string, boolean>;
  policyAfterReload?: NekProjectTrust["defaultProjectTrust"];
};

function storedDecision(cwd: string, decisions: Map<string, boolean>): boolean | null {
  return (
    decisions.get(cwd) ?? (dirname(cwd) !== cwd ? storedDecision(dirname(cwd), decisions) : null)
  );
}

function fakeProcess(
  kind: "control" | "session",
  extensionUi?: NekExtensionUiHandler,
  { decisions = new Map<string, boolean>(), policyAfterReload, ...facts }: TrustFixture = {},
): FakeProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const write = (record: unknown) => stdout.write(`${JSON.stringify(record)}\n`);
  const historyStream = createHistoryStream(write, {
    sessionId: "s1",
    sessionPath: "/tmp/session.jsonl",
  });
  const commands: NekRpcCommand[] = [];
  const responses: unknown[] = [];
  const exits = new Set<(info: NekRpcProcessExit) => void>();
  let input = "";
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString("utf8");
    for (;;) {
      const index = input.indexOf("\n");
      if (index < 0) break;
      const line = input.slice(0, index);
      input = input.slice(index + 1);
      if (!line) continue;
      const command = JSON.parse(line) as NekRpcCommand & { id?: string };
      if (command.type === "extension_ui_response") {
        responses.push(command);
        continue;
      }
      commands.push(command);
      if (!command.id) continue;
      let data: unknown = {};
      if (command.type === "set_history_stream") {
        data = historyStream.negotiate();
      } else if (
        command.type === "read_history_page" ||
        command.type === "read_session_metadata" ||
        command.type === "read_history_subagent"
      ) {
        data = fixtureHistory([], command);
      } else if (kind === "control") {
        if (command.type === "get_project_trust") {
          data = {
            ...DEFAULT_TRUST,
            ...facts,
            cwd: command.cwd,
            trusted: storedDecision(command.cwd, decisions),
          };
        } else if (command.type === "reload") {
          if (policyAfterReload) facts.defaultProjectTrust = policyAfterReload;
          data = { deferred: false, diagnostics: [] };
        } else if (command.type === "set_project_trust") {
          decisions.set(command.cwd, command.trusted);
        } else if (command.type === "list_sessions") {
          data = { sessions: [] };
        }
      } else if (command.type === "get_state") {
        data = {
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "one-at-a-time",
          sessionFile: "/tmp/session.jsonl",
          sessionId: "s1",
        };
      } else if (command.type === "get_entries") {
        data = { entries: [], leafId: null };
      } else if (command.type === "get_session_stats") {
        data = {
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
      } else if (command.type === "extension_call") {
        data = { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
      }
      write({ id: command.id, type: "response", command: command.type, success: true, data });
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
    for (const listener of exits) listener(info);
    exits.clear();
  };
  return {
    commands,
    responses,
    emit: (record) => historyStream.emit(record as Record<string, unknown>),
    process: {
      client,
      guiInfo,
      pid: undefined,
      exitInfo: () => undefined,
      onExit: (listener) => handle.onExit(() => listener()),
      dispose: async () => {
        emitExit({ code: 0, signal: null });
        await client.close();
      },
    },
  };
}

function harness(overrides: Partial<NekAgentServiceOptions> = {}, trust?: TrustFixture) {
  const control = fakeProcess("control", undefined, trust);
  const sessions: FakeProcess[] = [];
  const sessionArgs: string[][] = [];
  const service = new NekAgentService({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      sessionArgs.push(buildNekRpcArgs(request));
      const session = fakeProcess("session", request.extensionUi);
      sessions.push(session);
      return session.process;
    },
    ...overrides,
  });
  const frames: NekInteractionFrame[] = [];
  service.onInteractionEvent((frame) => frames.push(frame));
  return { control, sessions, sessionArgs, service, frames };
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${message}`);
}

const AGENTS = { kind: "agents", path: `${CWD}/.nek/agents` } as const;

for (const { label, facts, trusted, reload } of [
  { label: "no gated resources under ask", facts: { resources: [] }, trusted: true },
  {
    label: "agents alone even under never",
    facts: { resources: [AGENTS], defaultProjectTrust: "never" },
    trusted: true,
  },
  {
    label: "stored ancestor trust overrides never",
    facts: { decisions: new Map([["/", true]]), defaultProjectTrust: "never" },
    trusted: true,
  },
  {
    label: "stored ancestor denial overrides even no resources",
    facts: { decisions: new Map([["/", false]]), resources: [] },
    trusted: false,
  },
  {
    label: "nearest record overrides parent",
    facts: {
      decisions: new Map([
        ["/", true],
        [CWD, false],
      ]),
    },
    trusted: false,
  },
  {
    label: "always with gated resources",
    facts: { defaultProjectTrust: "always" },
    trusted: true,
    reload: true,
  },
  {
    label: "never with gated resources",
    facts: { defaultProjectTrust: "never" },
    trusted: false,
    reload: true,
  },
  {
    label: "refreshes the cached policy before allowing project config",
    facts: { defaultProjectTrust: "always", policyAfterReload: "never" },
    trusted: false,
    reload: true,
  },
] satisfies Array<{ label: string; facts: TrustFixture; trusted: boolean; reload?: boolean }>) {
  test(`PT-1 opens without asking: ${label}`, async () => {
    const { control, frames, service, sessionArgs } = harness({}, facts);
    try {
      const created = await service.createSession({ cwd: CWD });
      assert.equal(created.readonly, false);
      assert.deepEqual(frames, []);
      assert.deepEqual(
        control.commands.map(({ type }) => type),
        reload ? ["get_project_trust", "reload", "get_project_trust"] : ["get_project_trust"],
      );
      assert.deepEqual(sessionArgs[0], ["--mode", "rpc", trusted ? "--approve" : "--no-approve"]);
    } finally {
      await service.dispose();
    }
  });
}

async function selectFrame(frames: NekInteractionFrame[]) {
  await waitFor(() => frames.length > 0, "the trust select request");
  const frame = frames[0];
  if (frame?.kind !== "request" || frame.request.method !== "select") {
    throw new Error("expected a trust select frame");
  }
  return frame.request;
}

for (const { answer, saved, trusted } of [
  { answer: "trust", saved: CWD, trusted: true },
  { answer: "trust-parent", saved: "/", trusted: true },
  { answer: "trust-session", saved: undefined, trusted: true },
  { answer: "deny", saved: CWD, trusted: false },
  { answer: "deny-session", saved: undefined, trusted: false },
  { answer: undefined, saved: undefined, trusted: false },
] satisfies Array<{ answer?: NekProjectTrustChoice; saved?: string; trusted: boolean }>) {
  test(`PT-2/PT-3/PT-4 selects ${answer ?? "close / Esc"} and starts with the matching flag`, async () => {
    const decisions = new Map<string, boolean>();
    const { control, frames, service, sessionArgs } = harness(
      {},
      {
        decisions,
        resources: [...DEFAULT_TRUST.resources, AGENTS],
      },
    );
    try {
      const pending = service.createSession({ cwd: CWD });
      const request = await selectFrame(frames);
      assert.deepEqual(frames[0]?.scope, { workspacePath: CWD });
      assert.deepEqual(request.options, [
        "trust",
        "trust-parent",
        "trust-session",
        "deny",
        "deny-session",
      ]);
      assert.deepEqual(request.projectTrust, {
        cwd: CWD,
        parentPath: "/",
        resourcePaths: [`${CWD}/.nek/settings.json`],
      });
      assert.deepEqual(sessionArgs, [], "do not start nek before choosing");
      assert.equal(
        service.respondInteraction({
          type: "extension_ui_response",
          id: request.id,
          ...(answer ? { value: answer } : { cancelled: true }),
        }),
        true,
      );
      const session = await pending;
      assert.equal(session.readonly, false);
      assert.equal(session.phase, "idle");
      assert.deepEqual(sessionArgs[0], ["--mode", "rpc", trusted ? "--approve" : "--no-approve"]);
      assert.deepEqual([...decisions], saved ? [[saved, trusted]] : []);
      assert.equal(
        control.commands.filter(({ type }) => type === "set_project_trust").length,
        saved ? 1 : 0,
      );
      if (saved) {
        await service.closeSession(session.sessionKey);
        await service.createSession({ cwd: CWD });
        assert.equal(
          frames.length,
          1,
          "the next session uses the persisted decision without asking",
        );
        assert.deepEqual(sessionArgs[1], sessionArgs[0]);
      }
    } finally {
      await service.dispose();
    }
  });
}

test("PT-2 root projects have no parent option; aliases use the canonical resource parent", async () => {
  for (const [cwd, config, expected] of [
    ["/", "/.nek/mcp.json", undefined],
    ["/symlink", "/real/nested/work/.nek/mcp.json", "/real/nested"],
  ] as const) {
    const { frames, service } = harness({}, { resources: [{ kind: "mcp", path: config }] });
    try {
      const pending = service.createSession({ cwd });
      const request = await selectFrame(frames);
      assert.equal(request.options.includes("trust-parent"), expected !== undefined);
      assert.equal(request.projectTrust?.parentPath, expected);
      service.respondInteraction({
        type: "extension_ui_response",
        id: request.id,
        cancelled: true,
      });
      await pending;
    } finally {
      await service.dispose();
    }
  }
});

test("PT-3 parent trust refuses to override a record saved while the card was open", async () => {
  const decisions = new Map<string, boolean>();
  const { frames, service, sessionArgs } = harness({}, { decisions });
  try {
    const pending = service.createSession({ cwd: CWD });
    const request = await selectFrame(frames);
    decisions.set(CWD, false);
    service.respondInteraction({
      type: "extension_ui_response",
      id: request.id,
      value: "trust-parent",
    });
    await assert.rejects(pending, /trust changed.*reopen the session/u);
    assert.deepEqual([...decisions], [[CWD, false]]);
    assert.deepEqual(sessionArgs, []);
  } finally {
    await service.dispose();
  }
});

test("PT-4 trust select has no implicit deadline; ordinary dialogs still time out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = new NekGuiInteractionBridge({ timeoutMs: 300_000, maxPending: 2 });
  const handler = bridge.scoped({ workspacePath: CWD });
  const signal = new AbortController().signal;
  try {
    const trust = handler.dialog!(
      {
        type: "extension_ui_request",
        id: "trust",
        method: "select",
        title: "Trust",
        options: ["trust"],
        projectTrust: { cwd: CWD, resourcePaths: [`${CWD}/.nek/settings.json`] },
      },
      signal,
    );
    const ordinary = handler.dialog!(
      {
        type: "extension_ui_request",
        id: "dialog",
        method: "select",
        title: "Select",
        options: ["one"],
      },
      signal,
    );
    t.mock.timers.tick(600_000);
    assert.deepEqual(await ordinary, { cancelled: true });
    assert.equal(bridge.pendingFrames(CWD).length, 1);
    bridge.respond({ type: "extension_ui_response", id: "trust", value: "trust" });
    assert.deepEqual(await trust, { value: "trust" });
  } finally {
    bridge.dispose();
  }
});

test("P2: leaving and returning to a workspace preserves and replays pending approval", async () => {
  const control = fakeProcess("control");
  const sessions: FakeProcess[] = [];
  const service = new NekAgentService({
    guiInfo,
    createControlProcess: () => control.process,
    createSessionProcess: (request) => {
      const session = fakeProcess("session", request.extensionUi);
      sessions.push(session);
      return session.process;
    },
  });
  const channel = new NekAgentInteractionChannel(service);
  const frames: NekInteractionFrame[] = [];
  try {
    const first = channel.onDynamic({ workspacePath: "/workspace" })((frame) => frames.push(frame));
    const second = channel.onDynamic({ workspacePath: "/workspace" })(() => undefined);
    const pending = service.createSession({ cwd: "/workspace" });
    await waitFor(() => frames.some((frame) => frame.kind === "request"), "the trust request");

    // 还有一个 renderer 订阅者：请求必须继续等回答，不能被提前取消。
    first.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      frames.some((frame) => frame.kind === "cancel"),
      false,
      "one remaining subscriber must keep the request pending",
    );

    // 离开界面不是拒绝；返回后重放同一 request，直到用户真正作出决定。
    second.dispose();
    assert.equal(service.pendingInteractions("/workspace").length, 1);
    const replay: NekInteractionFrame[] = [];
    const returned = channel.onDynamic({ workspacePath: "/workspace" })((frame) =>
      replay.push(frame),
    );
    assert.equal(replay.length, 1);
    const request = replay[0];
    if (request?.kind !== "request") throw new Error("expected replayed approval");
    await channel.respond({
      type: "extension_ui_response",
      id: request.request.id,
      value: "trust",
    });
    assert.equal((await pending).readonly, false);
    assert.equal(service.pendingInteractions("/workspace").length, 0);
    returned.dispose();
    assert.deepEqual(
      control.commands.map((command) => command.type),
      ["get_project_trust", "reload", "get_project_trust", "set_project_trust"],
    );
  } finally {
    channel.dispose();
    await service.dispose();
  }
});

test("P2/P3: structured mode and plan approvals survive identity-scoped reconnects", async () => {
  const { service, sessions } = harness({ askProjectTrust: () => "trust" });
  const channel = new NekAgentInteractionChannel(service);
  const target = { workspacePath: "/workspace", workspaceIdentity: "local-workspace" };
  const other: NekInteractionFrame[] = [];
  const unrelated = channel.onDynamic({ workspacePath: "/other" })((frame) => other.push(frame));
  try {
    const created = await service.createSession({ cwd: target.workspacePath });
    const session = sessions[0]!;
    for (const kind of ["nek.switch_mode", "nek.plan_review"]) {
      const id = `approval-${kind}`;
      const frames: NekInteractionFrame[] = [];
      const listener = channel.onDynamic(target)((frame) => frames.push(frame));
      session.emit({ type: "extension_ui_request", id, method: "structured", kind, payload: {} });
      await waitFor(() => frames.length === 1, "identity-scoped approval");
      assert.equal(frames[0]?.scope.sessionId, created.sessionId);
      listener.dispose();
      assert.equal(session.responses.length, kind === "nek.switch_mode" ? 0 : 1);
      const replay: NekInteractionFrame[] = [];
      const returned = channel.onDynamic(target)((frame) => replay.push(frame));
      assert.equal(replay.length, 1);
      const result = kind === "nek.switch_mode" ? { approved: true } : { action: "implement" };
      await channel.respond({ type: "extension_ui_response", id, result });
      await waitFor(
        () => session.responses.length === (kind === "nek.switch_mode" ? 1 : 2),
        "nek approval response",
      );
      assert.deepEqual(session.responses.at(-1), { type: "extension_ui_response", id, result });
      returned.dispose();
    }
    assert.equal(other.length, 0);
  } finally {
    unrelated.dispose();
    channel.dispose();
    await service.dispose();
  }
});

test("nek structured questions and approvals still replay after the old five-minute limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const bridge = new NekGuiInteractionBridge({ timeoutMs: 300_000, maxPending: 3 });
  const scope = { workspacePath: "/workspace", sessionKey: "session" };
  const signal = new AbortController();
  const handler = bridge.scoped(scope);
  try {
    const kinds = ["nek.plan_review", "nek.switch_mode", "nek.ask_question"];
    const answers = kinds.map((kind) =>
      handler.structured!(
        { type: "extension_ui_request", id: kind, method: "structured", kind, payload: {} },
        signal.signal,
      ),
    );
    t.mock.timers.tick(600_000);
    const overflow = await handler.structured!(
      {
        type: "extension_ui_request",
        id: "overflow",
        method: "structured",
        kind: "nek.plan_review",
        payload: {},
      },
      signal.signal,
    );
    assert.deepEqual(overflow, { type: "extension_ui_response", id: "overflow", cancelled: true });
    assert.deepEqual(
      bridge
        .pendingFrames(scope.workspacePath)
        .map((frame) => frame.kind === "request" && frame.request.id),
      kinds,
    );
    signal.abort();
    assert.deepEqual(
      await Promise.all(answers),
      kinds.map((id) => ({ type: "extension_ui_response", id, cancelled: true })),
    );
    assert.deepEqual(bridge.pendingFrames(scope.workspacePath), []);
  } finally {
    bridge.dispose();
  }
});

test("sending new input settles the previous plan review and it cannot replay on resubscribe", async () => {
  const { sessions, service, frames } = harness({ askProjectTrust: () => "trust" });
  const channel = new NekAgentInteractionChannel(service);
  const scope = { workspacePath: "/workspace" };
  try {
    const session = await service.createSession({ cwd: scope.workspacePath });
    const proc = sessions[0]!;
    proc.emit({
      type: "extension_ui_request",
      id: "old-review",
      method: "structured",
      kind: "nek.plan_review",
      payload: {},
    });
    await waitFor(() => frames.some((frame) => frame.kind === "request"), "old review");
    await service.sendPrompt({
      sessionKey: session.sessionKey,
      message: "Please revise the plan",
      streamingBehavior: "steer",
    });
    assert.deepEqual(proc.responses, [
      { type: "extension_ui_response", id: "old-review", cancelled: true },
    ]);
    assert.ok(
      frames.some(
        (frame) =>
          frame.kind === "cancel" && frame.id === "old-review" && frame.reason === "superseded",
      ),
    );
    const replay: NekInteractionFrame[] = [];
    const returned = channel.onDynamic(scope)((frame) => replay.push(frame));
    assert.deepEqual(replay, []);
    returned.dispose();
  } finally {
    channel.dispose();
    await service.dispose();
  }
});

test("process exit cancels the live review without replying to the terminated process", async () => {
  const { sessions, service, frames } = harness({ askProjectTrust: () => "trust" });
  try {
    await service.createSession({ cwd: "/workspace" });
    const proc = sessions[0]!;
    proc.emit({
      type: "extension_ui_request",
      id: "review",
      method: "structured",
      kind: "nek.plan_review",
      payload: {},
    });
    await waitFor(() => frames.some((frame) => frame.kind === "request"), "review");
    await proc.process.dispose();
    assert.deepEqual(proc.responses, []);
    assert.deepEqual(service.pendingInteractions("/workspace"), []);
    assert.equal(
      frames.filter((frame) => frame.kind === "cancel" && frame.id === "review").length,
      1,
    );
  } finally {
    await service.dispose();
  }
});

test("PT-4 cancelling a workspace settles the pending trust selection as untrusted", async () => {
  const { service, frames, sessionArgs } = harness();
  try {
    const pending = service.createSession({ cwd: "/workspace" });
    await waitFor(() => frames.some((frame) => frame.kind === "request"), "the trust request");
    service.cancelWorkspaceInteractions("/workspace");
    assert.equal((await pending).phase, "idle");
    assert.ok(sessionArgs[0]?.includes("--no-approve"));
    assert.ok(
      frames.some((frame) => frame.kind === "cancel"),
      "workspace cancellation must publish a cancel frame",
    );
  } finally {
    await service.dispose();
  }
});

test("nek cancelling a session dialog publishes a cancel frame and answers nek", async () => {
  const { sessions, service, frames } = harness({ askProjectTrust: () => "trust" });
  try {
    const created = await service.createSession({ cwd: "/workspace" });
    const session = sessions[0];
    if (!session) throw new Error("expected a session process");
    session.emit({
      type: "extension_ui_request",
      id: "ask-1",
      method: "input",
      title: "Which file?",
    });
    await waitFor(() => frames.length > 0, "the session dialog request");
    const frame = frames[0];
    assert.equal(frame?.kind, "request");
    assert.equal(frame?.scope.sessionKey, created.sessionKey);

    session.emit({ type: "extension_ui_cancel", id: "ask-1" });
    await waitFor(
      () => frames.some((candidate) => candidate.kind === "cancel"),
      "the cancel frame",
    );
    assert.equal(
      service.respondInteraction({
        type: "extension_ui_response",
        id: "ask-1",
        cancelled: true,
      }),
      false,
    );
  } finally {
    await service.dispose();
  }
});

test("an unattached renderer channel is a wiring error, but recorded trust still opens", async () => {
  const askControl = fakeProcess("control");
  const untrusted = new NekAgentService({
    guiInfo,
    createControlProcess: () => askControl.process,
    createSessionProcess: (request) => fakeProcess("session", request.extensionUi).process,
  });
  try {
    await assert.rejects(
      untrusted.createSession({ cwd: "/workspace" }),
      /no renderer is subscribed to the nek interaction channel/u,
    );
  } finally {
    await untrusted.dispose();
  }

  // 已经记录过的信任不需要询问，也不该因为渲染层没订阅而失败。
  const trustedControl = fakeProcess("control", undefined, {
    decisions: new Map([[CWD, true]]),
  });
  const trusted = new NekAgentService({
    guiInfo,
    createControlProcess: () => trustedControl.process,
    createSessionProcess: (request) => fakeProcess("session", request.extensionUi).process,
  });
  try {
    const created = await trusted.createSession({ cwd: "/workspace" });
    assert.equal(created.readonly, false);
    assert.deepEqual(
      trustedControl.commands.map((command) => command.type),
      ["get_project_trust"],
    );
  } finally {
    await trusted.dispose();
  }
});
