import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type {
  NekMcpServerStatus,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcResponseDataFor,
} from "@zcode/shared/nek-protocol";
import { AGENT_DIR, LOCAL, PROJECT, PROJECT_DIR, createHarness } from "./nekConfigApiHarness.js";
import type { NekReloadOutcome } from "../src/nek-config-api/index.js";
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
  const writtenRevision = (await harness.api.readModelsConfig(LOCAL)).revision;
  assert.equal(
    changes.filter((change) => change.revision === writtenRevision).length,
    1,
    "exactly one publication per write, in addition to initial observation",
  );
  assert.equal(changes.at(-1)?.file, MODELS_PATH);
  assert.equal(changes.at(-1)?.revision, writtenRevision);
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
  changes.length = 0;
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

test("MW-R1: scoped reload reaches its workspace plus control, never another workspace", async () => {
  const harness = createHarness();
  const calls: string[] = [];
  harness.sessions.push(
    {
      ...session({
        key: "a",
        reload: async () => {
          calls.push("a");
          return { deferred: false, diagnostics: [] };
        },
      }),
      cwd: "/a",
    },
    {
      ...session({
        key: "b",
        reload: async () => {
          calls.push("b");
          return { deferred: false, diagnostics: [] };
        },
      }),
      cwd: "/b",
    },
    session({
      key: "unknown",
      reload: async () => {
        calls.push("unknown");
        return { deferred: false, diagnostics: [] };
      },
    }),
  );
  await harness.api.getAuthStatus(LOCAL);
  const result = await harness.api.reloadRunningSessions(LOCAL, "/a");
  assert.deepEqual(calls, ["a"]);
  assert.equal(result.reloaded, 2);
  assert.equal(harness.control.commands.filter((command) => command.type === "reload").length, 1);
  harness.api.dispose();
});

test("MW-R2: automatic project settings write does not reload other workspaces", async () => {
  const harness = createHarness({ autoReload: true });
  const calls: string[] = [];
  for (const cwd of ["/a", "/b"])
    harness.sessions.push({
      ...session({
        key: cwd,
        reload: async () => {
          calls.push(cwd);
          return { deferred: false, diagnostics: [] };
        },
      }),
      cwd,
    });
  const view = await harness.api.readSettings(LOCAL, "project", "/a");
  const reloaded = new Promise<void>((resolve) =>
    harness.api.onReloadResult(LOCAL, () => resolve()),
  );
  await harness.api.patchSettings(
    LOCAL,
    "project",
    { defaultModel: "a" },
    { revision: view.revision, cwd: "/a" },
  );
  await reloaded;
  assert.deepEqual(calls, ["/a"]);
  harness.api.dispose();
});

test("reload reports a failing session as a process failure instead of throwing", async () => {
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
  assert.deepEqual(outcome.diagnostics, []);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0]?.sessionKey, "crashed");
  assert.match(outcome.failures[0]?.message ?? "", /stdin closed/);
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
        if ((command as NekRpcCommandOfType<"extension_call">).method === "mcp.status")
          return { result: { servers: [status] } };
        return { result: { server: status } };
      }) as NekConfigSessionHandle["call"],
    }),
  );
  assert.deepEqual(await harness.api.getMcpStatus(LOCAL), [status]);
  assert.deepEqual(await harness.api.mcpServerAction(LOCAL, "filesystem", "reconnect"), status);
});

test("watch events carry the scope of the file that changed", async () => {
  const projectPreset = join(PROJECT_DIR, "agents", "project-reviewer.md");
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsText("http://a"),
      [projectPreset]: "---\nname: project-reviewer\ndescription: x\n---\n\nBody.\n",
    },
    pollSeconds: 1,
  });
  const changes: Array<{ file: string; revision: string; scope: string }> = [];
  const unsubscribe = harness.api.watch(LOCAL, (change) => changes.push(change), PROJECT);
  // 等第一轮扫描建立基线。
  await new Promise((resolve) => setTimeout(resolve, 100));

  harness.local.setFile(MODELS_PATH, modelsText("http://global"));
  harness.local.setFile(
    projectPreset,
    "---\nname: project-reviewer\ndescription: y\n---\n\nBody.\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 1400));
  unsubscribe();

  const scopes = new Map(changes.map((change) => [change.file, change.scope]));
  assert.equal(scopes.get(MODELS_PATH), "global");
  assert.equal(scopes.get(projectPreset), "project");
});

test("our own project writes are published with the project scope", async () => {
  const projectMcp = join(PROJECT_DIR, "mcp.json");
  const harness = createHarness({
    localFiles: {
      [join(AGENT_DIR, "mcp.json")]: JSON.stringify({
        mcpServers: { docs: { url: "https://docs" } },
      }),
      [projectMcp]: JSON.stringify({ mcpServers: { docs: { enabled: true } } }),
    },
  });
  const changes: Array<{ file: string; revision: string; scope: string }> = [];
  const unsubscribe = harness.api.watch(LOCAL, (change) => changes.push(change), PROJECT);
  const before = await harness.api.readMcpConfig(LOCAL, "project", PROJECT);
  await harness.api.setMcpServerOverride(
    LOCAL,
    "docs",
    { enabled: false },
    { revision: before.revision, scope: "project", cwd: PROJECT },
  );
  unsubscribe();
  const written = changes.find((change) => change.file === projectMcp);
  assert.ok(written, "project mcp.json write is published");
  assert.equal(written.scope, "project");
});

test("a failing automatic reload is reported through onReloadResult", async () => {
  const harness = createHarness({ localFiles: { [SETTINGS_PATH]: "{}" }, autoReload: true });
  harness.sessions.push(
    session({
      key: "crashed",
      call: (async () => {
        throw new Error("stdin closed");
      }) as NekConfigSessionHandle["call"],
    }),
  );
  const results: NekReloadOutcome[] = [];
  const unsubscribe = harness.api.onReloadResult(LOCAL, (result) => results.push(result));

  const read = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { defaultModel: "a/b" },
    { revision: read.revision },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  unsubscribe();

  assert.equal(results.length, 1, "one notification per automatic reload");
  assert.equal(results[0]?.reloaded, 0);
  assert.equal(results[0]?.failures[0]?.sessionKey, "crashed");
  assert.match(results[0]?.failures[0]?.message ?? "", /stdin closed/);
});
