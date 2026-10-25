import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type {
  NekExtensionUiDialogRequest,
  NekExtensionUiRequest,
  NekExtensionUiResponse,
  NekRpcCommand,
} from "@zcode/shared/nek-protocol";
import type {
  NekRpcClientOptions,
  NekRpcProcessExit,
  NekRpcProcessHandle,
} from "../src/nek-agent/nekRpcClient.js";
import { NekRpcClient } from "../src/nek-agent/nekRpcClient.js";
import {
  NekRpcClosedError,
  NekRpcCommandError,
  NekRpcProcessExitedError,
  NekRpcTimeoutError,
} from "../src/nek-agent/nekRpcErrors.js";

/**
 * 客户端是整条链路的仲裁者：id 关联、超时、进程退出、扩展 UI 路由。
 * 这里用内存管道替身子进程，协议记录走真正的 JSONL。
 */

interface Harness {
  client: NekRpcClient;
  /** 客户端写到 stdin 的记录（按到达顺序）。 */
  commands: NekRpcCommand[];
  responses: NekExtensionUiResponse[];
  emit: (record: unknown) => void;
  exit: (info?: Partial<NekRpcProcessExit>) => void;
  killed: () => boolean;
  stdinEnded: () => boolean;
  handle: NekRpcProcessHandle;
}

function createHarness(options: NekRpcClientOptions = {}): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: NekRpcCommand[] = [];
  const responses: NekExtensionUiResponse[] = [];
  const listeners = new Set<(info: NekRpcProcessExit) => void>();
  let killed = false;
  let exited = false;
  let stdinEnded = false;
  let buffered = "";

  stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (true) {
      const index = buffered.indexOf("\n");
      if (index === -1) break;
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line === "") continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "extension_ui_response") responses.push(parsed as NekExtensionUiResponse);
      else commands.push(parsed as NekRpcCommand);
    }
  });
  const originalEnd = stdin.end.bind(stdin);
  stdin.end = ((...args: never[]) => {
    stdinEnded = true;
    return originalEnd(...(args as []));
  }) as typeof stdin.end;

  const exit = (info: Partial<NekRpcProcessExit> = {}) => {
    if (exited) return;
    exited = true;
    const full: NekRpcProcessExit = { code: info.code ?? 0, signal: info.signal ?? null, ...info };
    for (const listener of Array.from(listeners)) listener(full);
  };

  const handle: NekRpcProcessHandle = {
    stdin,
    stdout,
    stderr,
    kill: () => {
      killed = true;
      exit({ code: null, signal: "SIGKILL" });
    },
    onExit: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const client = new NekRpcClient(handle, options);
  return {
    client,
    commands,
    responses,
    handle,
    emit: (record) => stdout.write(`${JSON.stringify(record)}\n`),
    exit,
    killed: () => killed,
    stdinEnded: () => stdinEnded,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("correlates responses by id, not by order", async () => {
  const harness = createHarness({ requestIdPrefix: "t" });
  const first = harness.client.call({ type: "get_state" });
  const second = harness.client.call({ type: "get_session_stats" });
  await waitFor(() => harness.commands.length === 2);
  const [stateCommand, statsCommand] = harness.commands;
  assert.deepEqual(
    harness.commands.map((command) => command.type),
    ["get_state", "get_session_stats"],
  );
  // 反序回答：客户端必须按 id 关联。
  harness.emit({
    id: statsCommand?.id,
    type: "response",
    command: "get_session_stats",
    success: true,
    data: { sessionId: "s2", userMessages: 1 },
  });
  harness.emit({
    id: stateCommand?.id,
    type: "response",
    command: "get_state",
    success: true,
    data: { sessionId: "s1", thinkingLevel: "high" },
  });
  const state = await first;
  const stats = await second;
  assert.equal(state.sessionId, "s1");
  assert.equal(stats.sessionId, "s2");
  assert.equal(harness.client.pendingCount, 0);
});

test("honors a caller-supplied id (bash correlates bash_execution_update)", async () => {
  const harness = createHarness();
  const pending = harness.client.call({ id: "req-7", type: "bash", command: "ls" });
  await waitFor(() => harness.commands.length === 1);
  assert.equal(harness.commands[0]?.id, "req-7");
  harness.emit({
    id: "req-7",
    type: "response",
    command: "bash",
    success: true,
    data: { output: "ok", exitCode: 0 },
  });
  assert.equal((await pending).output, "ok");
});

test("rejects with NekRpcCommandError on success:false", async () => {
  const harness = createHarness();
  const pending = harness.client.call({ type: "set_model", provider: "a", modelId: "b" });
  await waitFor(() => harness.commands.length === 1);
  const id = harness.commands[0]?.id;
  harness.emit({
    id,
    type: "response",
    command: "set_model",
    success: false,
    error: "Model not found: a/b",
  });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof NekRpcCommandError);
    assert.equal(error.command, "set_model");
    assert.match(error.message, /Model not found/u);
    return true;
  });
});

test("times out per command type and forgets the pending request", async () => {
  const harness = createHarness({ timeouts: { get_state: 15 } });
  const pending = harness.client.call({ type: "get_state" });
  await assert.rejects(pending, (error: unknown) => error instanceof NekRpcTimeoutError);
  assert.equal(harness.client.pendingCount, 0);
  // 迟到的响应只记日志，不会二次 resolve。
  harness.emit({
    id: harness.commands[0]?.id,
    type: "response",
    command: "get_state",
    success: true,
    data: {},
  });
});

test("prompt resolves on preflight disposition without waiting for the turn", async () => {
  const harness = createHarness();
  const pending = harness.client.call({ type: "prompt", message: "hi" });
  await waitFor(() => harness.commands.length === 1);
  harness.emit({
    id: harness.commands[0]?.id,
    type: "response",
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });
  assert.deepEqual(await pending, { disposition: "started" });
});

test("fails every pending request with the stderr tail when the process exits", async () => {
  const harness = createHarness();
  const pending = harness.client.call({ type: "get_state" });
  await waitFor(() => harness.commands.length === 1);
  harness.handle.stderr?.write("boom: provider key missing\n");
  await waitFor(() => harness.client.stderrText().includes("boom"));
  harness.exit({ code: 2 });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof NekRpcProcessExitedError);
    assert.match(error.message, /boom: provider key missing/u);
    assert.equal(error.code, 2);
    return true;
  });
});

test("routes dialog requests to the handler and answers on stdin", async () => {
  const seen: NekExtensionUiDialogRequest[] = [];
  const harness = createHarness({
    extensionUi: {
      dialog: (request) => {
        seen.push(request);
        return { value: "Allow" };
      },
    },
  });
  const request: NekExtensionUiRequest = {
    type: "extension_ui_request",
    id: "ui-1",
    method: "select",
    title: "Allow dangerous command?",
    options: ["Allow", "Block"],
  };
  harness.emit(request);
  await waitFor(() => harness.responses.length === 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(harness.responses[0], {
    type: "extension_ui_response",
    id: "ui-1",
    value: "Allow",
  });
});

test("routes structured requests and passes through structured results", async () => {
  const harness = createHarness({
    extensionUi: {
      structured: (request) => ({
        type: "extension_ui_response",
        id: request.id,
        result: { ok: 1 },
      }),
    },
  });
  harness.emit({
    type: "extension_ui_request",
    id: "ui-2",
    method: "structured",
    kind: "nek.ask_question",
    payload: { questions: [] },
  });
  await waitFor(() => harness.responses.length === 1);
  assert.deepEqual(harness.responses[0], {
    type: "extension_ui_response",
    id: "ui-2",
    result: { ok: 1 },
  });
});

test("answers cancelled when no handler is installed, so nek never hangs", async () => {
  const harness = createHarness();
  harness.emit({
    type: "extension_ui_request",
    id: "ui-3",
    method: "confirm",
    title: "t",
    message: "m",
  });
  await waitFor(() => harness.responses.length === 1);
  assert.deepEqual(harness.responses[0], {
    type: "extension_ui_response",
    id: "ui-3",
    cancelled: true,
  });
});

test("extension_ui_cancel aborts the in-flight dialog and notifies the handler", async () => {
  let aborted = false;
  const cancelled: string[] = [];
  const harness = createHarness({
    extensionUi: {
      dialog: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(undefined);
          });
        }),
      cancelled: (id) => cancelled.push(id),
    },
  });
  harness.emit({ type: "extension_ui_request", id: "ui-4", method: "input", title: "t" });
  await waitFor(() => harness.client.pendingCount === 0);
  harness.emit({ type: "extension_ui_cancel", id: "ui-4" });
  await waitFor(() => aborted);
  assert.deepEqual(cancelled, ["ui-4"]);
  // 撤销后不再回响应：对端已经关掉了这个请求。
  assert.equal(harness.responses.length, 0);
});

test("fire-and-forget requests are notified without a response", async () => {
  const notifications: string[] = [];
  const harness = createHarness({
    extensionUi: { fireAndForget: (request) => notifications.push(request.method) },
  });
  harness.emit({ type: "extension_ui_request", id: "ui-5", method: "notify", message: "hi" });
  harness.emit({
    type: "extension_ui_request",
    id: "ui-6",
    method: "setWidget",
    widgetKey: "k",
    widgetLines: ["a"],
  });
  await waitFor(() => notifications.length === 2);
  assert.deepEqual(notifications, ["notify", "setWidget"]);
  assert.equal(harness.responses.length, 0);
});

test("delivers session events to typed listeners", async () => {
  const harness = createHarness();
  const events: string[] = [];
  harness.client.onEvent("tool_execution_start", (event) => events.push(event.toolCallId));
  harness.client.onAnyEvent((event) => events.push(`any:${event.type}`));
  harness.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: {} });
  assert.deepEqual(events, ["call_1", "any:tool_execution_start"]);
});

test("close ends stdin, then kills the tree when the process stays alive", async () => {
  const harness = createHarness({ closeGraceMs: 10 });
  const pending = harness.client.call({ type: "get_state" });
  // 先挂上拒绝处理器：close() 会同步结束挂起请求，晚挂就会变成未处理拒绝。
  const settled = pending.then(
    () => null,
    (error: unknown) => error,
  );
  await harness.client.close();
  // 关闭时挂起请求以 NekRpcClosedError 结束（不是超时，也不是协议错误）。
  assert.ok((await settled) instanceof NekRpcClosedError);
  assert.equal(harness.stdinEnded(), true);
  assert.equal(harness.killed(), true);
  assert.equal(harness.client.state, "closed");
});
