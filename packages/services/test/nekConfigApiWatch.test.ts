import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type {
  NekMcpServerStatus,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcResponseDataFor,
} from "@zcode/shared/nek-protocol";
import { AGENT_DIR, LOCAL, createHarness } from "./nekConfigApiHarness.js";
import type { NekConfigSessionHandle } from "../src/nek-config-api/index.js";

/**
 * watch 与 reload：
 * - 本端写入立刻推 `{file, revision}`（不等文件系统事件）；
 * - 外部改动由轮询发现（远程目标的做法）；
 * - reload 发给所有 nek 进程，回合正在跑的计入 deferred。
 */

const MODELS_PATH = join(AGENT_DIR, "models.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

function modelsText(baseUrl: string): string {
  return JSON.stringify({
    providers: { local: { api: "openai-completions", baseUrl, models: [] } },
  });
}

function session(options: {
  reload?: () => Promise<{ deferred: boolean; diagnostics: never[] }>;
  key?: string;
  busy?: boolean;
  call?: <C extends NekRpcCommandType>(
    command: NekRpcCommandOfType<C>,
  ) => Promise<NekRpcResponseDataFor<C>>;
}): NekConfigSessionHandle {
  return {
    sessionKey: options.key ?? "s1",
    busy: options.busy ?? false,
    call:
      options.call ??
      ((async (command) => {
        if (command.type === "reload") {
          return options.reload ? await options.reload() : { deferred: false, diagnostics: [] };
        }
        throw new Error(`unexpected session command ${command.type}`);
      }) as NekConfigSessionHandle["call"]),
  };
}

test("our own writes are published to watchers immediately", async () => {
  const harness = createHarness({ localFiles: { [MODELS_PATH]: modelsText("http://a") } });
  const changes: Array<{ file: string; revision: string }> = [];
  const unsubscribe = harness.api.watch(LOCAL, (change) => changes.push(change));
  const view = await harness.api.readModelsConfig(LOCAL);
  const provider = view.providers[0];
  assert.ok(provider);
  const { apiKey: _apiKey, overridesBuiltin: _flag, ...rest } = provider;
  await harness.api.saveProvider(LOCAL, { ...rest, baseUrl: "http://b" } as never, {
    revision: view.revision,
    isNew: false,
  });
  unsubscribe();
  assert.equal(changes.length, 1, "exactly one change per write");
  assert.equal(changes[0]?.file, MODELS_PATH);
  assert.equal(changes[0]?.revision, (await harness.api.readModelsConfig(LOCAL)).revision);
});

test("external edits are detected by polling with the configured interval", async () => {
  const harness = createHarness({
    localFiles: { [MODELS_PATH]: modelsText("http://a") },
    pollSeconds: 1,
  });
  const changes: Array<{ file: string; revision: string }> = [];
  const unsubscribe = harness.api.watch(LOCAL, (change) => changes.push(change));
  // 等第一轮扫描建立基线，再模拟"nek 或用户改了文件"。
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = (await harness.api.readModelsConfig(LOCAL)).revision;
  harness.local.setFile(MODELS_PATH, modelsText("http://external"));
  await new Promise((resolve) => setTimeout(resolve, 1400));
  unsubscribe();
  assert.equal(changes.length, 1, "the polling watcher reports the external change once");
  assert.equal(changes[0]?.file, MODELS_PATH);
  assert.notEqual(changes[0]?.revision, before);
});

test("reload reaches every process and counts busy sessions as deferred", async () => {
  const harness = createHarness({ localFiles: { [SETTINGS_PATH]: "{}" } });
  const calls: string[] = [];
  harness.sessions.push(
    session({
      key: "idle",
      reload: async () => {
        calls.push("idle");
        return { deferred: false, diagnostics: [] };
      },
    }),
    session({
      key: "busy",
      busy: true,
      reload: async () => {
        calls.push("busy");
        return { deferred: false, diagnostics: [] };
      },
    }),
  );
  const outcome = await harness.api.reloadRunningSessions(LOCAL);
  assert.deepEqual(calls, ["idle", "busy"]);
  assert.equal(outcome.reloaded, 1);
  assert.equal(outcome.deferred, 1);
  assert.deepEqual(outcome.diagnostics, []);
});

test("reload reports a failing session as a diagnostic instead of throwing", async () => {
  const harness = createHarness({ localFiles: { [SETTINGS_PATH]: "{}" } });
  harness.sessions.push(
    session({
      key: "crashed",
      call: (async () => {
        throw new Error("stdin closed");
      }) as NekConfigSessionHandle["call"],
    }),
  );
  const outcome = await harness.api.reloadRunningSessions(LOCAL);
  assert.equal(outcome.reloaded, 0);
  assert.equal(outcome.diagnostics.length, 1);
  assert.match(outcome.diagnostics[0]?.message ?? "", /stdin closed/);
  assert.equal(outcome.diagnostics[0]?.severity, "error");
});

test("auto reload runs once after each write and can be turned off", async () => {
  const withReload = createHarness({
    localFiles: { [SETTINGS_PATH]: "{}" },
    autoReload: true,
  });
  let reloadCalls = 0;
  withReload.sessions.push(
    session({
      reload: async () => {
        reloadCalls += 1;
        return { deferred: false, diagnostics: [] };
      },
    }),
  );
  const read = await withReload.api.readSettings(LOCAL, "global");
  await withReload.api.patchSettings(
    LOCAL,
    "global",
    { defaultModel: "a/b" },
    { revision: read.revision },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reloadCalls, 1);

  const withoutReload = createHarness({ localFiles: { [SETTINGS_PATH]: "{}" }, autoReload: false });
  let disabledCalls = 0;
  withoutReload.sessions.push(
    session({
      reload: async () => {
        disabledCalls += 1;
        return { deferred: false, diagnostics: [] };
      },
    }),
  );
  const second = await withoutReload.api.readSettings(LOCAL, "global");
  await withoutReload.api.patchSettings(
    LOCAL,
    "global",
    { defaultModel: "a/b" },
    { revision: second.revision },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disabledCalls, 0);
});

test("mcp status and actions use the running session process", async () => {
  const harness = createHarness();
  const status: NekMcpServerStatus = {
    name: "filesystem",
    scope: "global",
    transport: "stdio",
    enabled: true,
    exposure: "deferred",
    state: "connected",
    tools: [{ name: "read_file", exposure: "deferred" }],
  };
  harness.sessions.push(
    session({
      key: "session-1",
      call: (async (command) => {
        if (command.type !== "extension_call") throw new Error(`unexpected ${command.type}`);
        if (command.method === "mcp.status") return { result: { servers: [status] } };
        return { result: { server: status } };
      }) as NekConfigSessionHandle["call"],
    }),
  );
  assert.deepEqual(await harness.api.getMcpStatus(LOCAL), [status]);
  assert.deepEqual(await harness.api.mcpServerAction(LOCAL, "filesystem", "reconnect"), status);
});
