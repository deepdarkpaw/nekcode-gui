import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { NekCopySelection } from "@zcode/shared/nek-protocol";
import {
  AGENT_DIR,
  LOCAL,
  REMOTE,
  REMOTE_AGENT_DIR,
  createHarness,
  expectNekError,
  readJson,
} from "./nekConfigApiHarness.js";
import { FakeControlClient } from "./nekConfigApiHarness.js";

/**
 * 复制到远程：同名项默认跳过，只有显式 `overwrite` 才覆盖；
 * OAuth 登录不在两台机器之间搬凭据，而是在目标机器上重新发起（需要用户输入时明确失败）。
 */

const localModels = join(AGENT_DIR, "models.json");
const localMcp = join(AGENT_DIR, "mcp.json");
const localSettings = join(AGENT_DIR, "settings.json");
const remoteModels = join(REMOTE_AGENT_DIR, "models.json");
const remoteMcp = join(REMOTE_AGENT_DIR, "mcp.json");
const remoteSettings = join(REMOTE_AGENT_DIR, "settings.json");

const selection: NekCopySelection = {
  providers: ["local-proxy", "shared"],
  logins: [],
  mcpServers: ["filesystem"],
  defaults: true,
  compaction: true,
};

function baseHarness() {
  return createHarness({
    localFiles: {
      [localModels]: JSON.stringify({
        providers: {
          "local-proxy": {
            name: "Local",
            api: "openai-completions",
            baseUrl: "http://local",
            models: [],
          },
          shared: {
            name: "Shared from local",
            api: "openai-completions",
            baseUrl: "http://shared",
            models: [],
          },
        },
      }),
      [localMcp]: JSON.stringify({
        mcpServers: { filesystem: { command: "npx", args: ["-y", "fs"] } },
      }),
      [localSettings]: JSON.stringify({
        defaultProvider: "local-proxy",
        defaultModel: "local-proxy/qwen",
        enabledModels: ["local-proxy/qwen"],
        compaction: { enabled: true, reserveTokens: 20000 },
      }),
    },
    remoteFiles: {
      [remoteModels]: JSON.stringify({
        providers: {
          shared: {
            name: "Shared from remote",
            api: "openai-completions",
            baseUrl: "http://remote",
            models: [],
          },
        },
      }),
      [remoteMcp]: JSON.stringify({ mcpServers: { filesystem: { command: "remote-fs" } } }),
      [remoteSettings]: JSON.stringify({
        defaultModel: "shared/x",
        compaction: { enabled: false },
      }),
    },
  });
}

test("copy preview reports conflicts for every selected item", async () => {
  const harness = baseHarness();
  const preview = await harness.api.previewCopy(LOCAL, REMOTE, selection);
  const byKey = new Map(preview.items.map((item) => [`${item.kind}:${item.id}`, item.conflict]));
  assert.equal(byKey.get("provider:local-proxy"), false);
  assert.equal(byKey.get("provider:shared"), true);
  assert.equal(byKey.get("mcpServer:filesystem"), true);
  assert.equal(byKey.get("defaults:defaults"), true);
  assert.equal(byKey.get("compaction:compaction"), true);
});

test("copy skips conflicting items unless the resolution says overwrite", async () => {
  const harness = baseHarness();
  await harness.api.copy(LOCAL, REMOTE, selection, {});
  const models = readJson(harness.remote, remoteModels) as {
    providers: Record<string, { baseUrl: string }>;
  };
  assert.equal(models.providers["local-proxy"]?.baseUrl, "http://local", "new provider is copied");
  assert.equal(
    models.providers.shared?.baseUrl,
    "http://remote",
    "conflicting provider is skipped",
  );
  const mcp = readJson(harness.remote, remoteMcp) as {
    mcpServers: Record<string, { command: string }>;
  };
  assert.equal(mcp.mcpServers.filesystem?.command, "remote-fs", "conflicting server is skipped");
  const settings = readJson(harness.remote, remoteSettings) as Record<string, unknown> & {
    compaction: { reserveTokens?: number };
  };
  assert.equal(settings.defaultModel, "shared/x", "defaults are skipped");
  assert.equal(settings.compaction.reserveTokens, undefined, "compaction is skipped");

  await harness.api.copy(LOCAL, REMOTE, selection, {
    "provider:shared": "overwrite",
    "mcpServer:filesystem": "overwrite",
    "defaults:defaults": "overwrite",
    "compaction:compaction": "overwrite",
  });
  const modelsAfter = readJson(harness.remote, remoteModels) as {
    providers: Record<string, { baseUrl: string }>;
  };
  assert.equal(modelsAfter.providers.shared?.baseUrl, "http://shared");
  const mcpAfter = readJson(harness.remote, remoteMcp) as {
    mcpServers: Record<string, { command: string }>;
  };
  assert.equal(mcpAfter.mcpServers.filesystem?.command, "npx");
  const settingsAfter = readJson(harness.remote, remoteSettings) as Record<string, unknown> & {
    compaction: { reserveTokens?: number };
  };
  assert.equal(settingsAfter.defaultProvider, "local-proxy");
  assert.equal(settingsAfter.defaultModel, "local-proxy/qwen");
  assert.deepEqual(settingsAfter.enabledModels, ["local-proxy/qwen"]);
  assert.equal(settingsAfter.compaction.reserveTokens, 20000);
});

test("copy logs in on the target machine instead of moving credentials", async () => {
  const control = new FakeControlClient();
  const harness = baseHarness();
  harness.useControl(control);
  const withLogin: NekCopySelection = {
    ...selection,
    providers: [],
    mcpServers: [],
    logins: ["anthropic"],
    defaults: false,
    compaction: false,
  };
  // 目标机器的控制进程很快完成 OAuth。
  setTimeout(() => control.completeLogin(), 0);
  await harness.api.copy(LOCAL, REMOTE, withLogin, {});
  assert.deepEqual(
    control.commands.map((command) => command.type),
    ["auth_status", "auth_login"],
  );
  assert.equal(
    harness.remote.files.has(join(REMOTE_AGENT_DIR, "auth.json")),
    false,
    "auth.json is never written",
  );
});

test("copy reports a failed item when the login needs user input on the target", async () => {
  const control = new FakeControlClient();
  const harness = baseHarness();
  harness.useControl(control);
  const withLogin: NekCopySelection = {
    ...selection,
    providers: [],
    mcpServers: [],
    logins: ["anthropic"],
    defaults: false,
    compaction: false,
  };
  setTimeout(() => {
    void control.pushPrompt({
      type: "extension_ui_request",
      id: "prompt-9",
      method: "structured",
      kind: "auth.prompt",
      payload: { provider: "anthropic", prompt: { type: "manual_code", message: "code" } },
    });
  }, 0);
  const result = await harness.api.copy(LOCAL, REMOTE, withLogin, {});
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item?.key, "login:anthropic");
  assert.equal(item?.status, "failed");
  assert.match(item?.error ?? "", /requires user input/);
});

test("copying onto the same target is rejected", async () => {
  const harness = baseHarness();
  const error = await expectNekError(
    async () =>
      await harness.api.copy(LOCAL, LOCAL, { ...selection, providers: [], mcpServers: [] }, {}),
    "validation",
  );
  assert.match(error.message, /same target/);
});

test("copy returns a per-item result instead of throwing midway", async () => {
  const control = new FakeControlClient();
  const harness = baseHarness();
  harness.useControl(control);
  setTimeout(() => control.failLogin("consent required on the target"), 0);
  const result = await harness.api.copy(
    LOCAL,
    REMOTE,
    {
      ...selection,
      logins: ["anthropic"],
    },
    {},
  );
  const byKey = new Map(result.items.map((item) => [item.key, item]));
  assert.equal(byKey.get("provider:local-proxy")?.status, "copied");
  assert.equal(byKey.get("provider:shared")?.status, "skipped");
  assert.equal(byKey.get("mcpServer:filesystem")?.status, "skipped");
  assert.equal(byKey.get("defaults:defaults")?.status, "skipped");
  assert.equal(byKey.get("compaction:compaction")?.status, "skipped");
  // 登录项失败不影响其他项的结果。
  const login = byKey.get("login:anthropic");
  assert.ok(login);
  assert.equal(login.status, "failed");
  assert.match(login.error ?? "", /consent required/);
});

test("copying defaults mirrors the source: no scope on the source clears the stale target scope", async () => {
  const harness = createHarness({
    localFiles: {
      [localSettings]: JSON.stringify({
        defaultProvider: "CPA",
        defaultModel: "claude-opus-5-5",
        compaction: { enabled: true },
      }),
    },
    remoteFiles: {
      [remoteSettings]: JSON.stringify({
        defaultProvider: "CPA",
        defaultModel: "old",
        defaultThinkingLevel: "low",
        enabledModels: ["CPA/a", "CPA/b"],
        compaction: { enabled: false, keepRecentTokens: 5 },
        lastChangelogVersion: "1.0.0",
      }),
    },
  });
  const selection = { providers: [], logins: [], mcpServers: [], defaults: true, compaction: true };
  const result = await harness.api.copy(LOCAL, REMOTE, selection, {
    "defaults:defaults": "overwrite",
    "compaction:compaction": "overwrite",
  });
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["copied", "copied"],
  );
  assert.deepEqual(readJson(harness.remote, remoteSettings), {
    defaultProvider: "CPA",
    defaultModel: "claude-opus-5-5",
    compaction: { enabled: true },
    lastChangelogVersion: "1.0.0",
  });
});

test("copying a provider carries its models' default thinking levels and drops stale ones", async () => {
  const provider = {
    name: "CPA",
    api: "openai-completions",
    baseUrl: "http://cpa",
    models: [{ id: "a" }, { id: "b" }],
  };
  const harness = createHarness({
    localFiles: {
      [localModels]: JSON.stringify({ providers: { CPA: provider } }),
      [localSettings]: JSON.stringify({
        modelThinkingLevels: { "CPA/a": "high", "other/x": "low" },
      }),
    },
    remoteFiles: {
      [remoteModels]: JSON.stringify({
        providers: { CPA: { ...provider, models: [{ id: "b" }] } },
      }),
      [remoteSettings]: JSON.stringify({
        modelThinkingLevels: { "CPA/b": "minimal", "remote/y": "medium" },
      }),
    },
  });
  const result = await harness.api.copy(
    LOCAL,
    REMOTE,
    { providers: ["CPA"], logins: [], mcpServers: [], defaults: false, compaction: false },
    { "provider:CPA": "overwrite" },
  );
  assert.deepEqual(result.items, [{ key: "provider:CPA", status: "copied" }]);
  const models = readJson(harness.remote, remoteModels) as {
    providers: Record<string, { models: Array<{ id: string }> }>;
  };
  assert.deepEqual(
    models.providers.CPA?.models.map((model) => model.id),
    ["a", "b"],
  );
  const settings = readJson(harness.remote, remoteSettings) as Record<string, unknown>;
  assert.deepEqual(settings.modelThinkingLevels, { "remote/y": "medium", "CPA/a": "high" });
});

test("copy preview flags values that depend on the source machine's environment", async () => {
  const files = {
    [localModels]: JSON.stringify({
      providers: {
        envKey: {
          api: "openai-completions",
          baseUrl: "http://a",
          apiKey: "${OPENAI_KEY}",
          headers: { "x-team": "team-$TEAM_ID", "x-literal": "price $$5" },
          models: [],
        },
        commandKey: {
          api: "openai-completions",
          baseUrl: "http://b",
          apiKey: "!op read op://vault/key",
          models: [],
        },
        literalKey: {
          api: "openai-completions",
          baseUrl: "http://c",
          apiKey: "sk-literal",
          models: [],
        },
      },
    }),
    [localMcp]: JSON.stringify({
      mcpServers: {
        windows: {
          command: "C:\\Users\\me\\.nek\\agent\\mcp\\search.exe",
          args: ["--config=C:\\Users\\me\\config.yaml"],
          env: { GITHUB_TOKEN: "$GITHUB_TOKEN" },
        },
        portable: { command: "npx", args: ["-y", "fs", "https://example.com/x"] },
      },
    }),
  };
  const selection = {
    providers: ["envKey", "commandKey", "literalKey"],
    logins: [],
    mcpServers: ["windows", "portable"],
    defaults: false,
    compaction: false,
  };
  const linux = await createHarness({ localFiles: files }).api.previewCopy(
    LOCAL,
    REMOTE,
    selection,
  );
  const warningsOf = (items: typeof linux.items) =>
    Object.fromEntries(items.map((item) => [`${item.kind}:${item.id}`, item.warnings]));
  assert.deepEqual(warningsOf(linux.items), {
    "provider:envKey": [{ kind: "env", names: ["OPENAI_KEY", "TEAM_ID"] }],
    "provider:commandKey": [{ kind: "command" }],
    "provider:literalKey": undefined,
    "mcpServer:windows": [{ kind: "env", names: ["GITHUB_TOKEN"] }, { kind: "windowsPath" }],
    "mcpServer:portable": undefined,
  });
  const windows = await createHarness({
    localFiles: files,
    remotePlatform: "win32",
  }).api.previewCopy(LOCAL, REMOTE, selection);
  assert.deepEqual(warningsOf(windows.items)["mcpServer:windows"], [
    { kind: "env", names: ["GITHUB_TOKEN"] },
  ]);
});

test("copy marks an empty settings source as skipped with a reason", async () => {
  const harness = createHarness({
    localFiles: { [localSettings]: JSON.stringify({ theme: "dark" }) },
    remoteFiles: { [remoteSettings]: JSON.stringify({}) },
  });
  const result = await harness.api.copy(
    LOCAL,
    REMOTE,
    { providers: [], logins: [], mcpServers: [], defaults: true, compaction: false },
    {},
  );
  assert.deepEqual(result.items, [
    { key: "defaults:defaults", status: "skipped", error: "the source has nothing to copy" },
  ]);
});
