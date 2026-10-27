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
          "local-proxy": { name: "Local", api: "openai-completions", baseUrl: "http://local", models: [] },
          shared: { name: "Shared from local", api: "openai-completions", baseUrl: "http://shared", models: [] },
        },
      }),
      [localMcp]: JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["-y", "fs"] } } }),
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
          shared: { name: "Shared from remote", api: "openai-completions", baseUrl: "http://remote", models: [] },
        },
      }),
      [remoteMcp]: JSON.stringify({ mcpServers: { filesystem: { command: "remote-fs" } } }),
      [remoteSettings]: JSON.stringify({ defaultModel: "shared/x", compaction: { enabled: false } }),
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
  const models = readJson(harness.remote, remoteModels) as { providers: Record<string, { baseUrl: string }> };
  assert.equal(models.providers["local-proxy"]?.baseUrl, "http://local", "new provider is copied");
  assert.equal(models.providers.shared?.baseUrl, "http://remote", "conflicting provider is skipped");
  const mcp = readJson(harness.remote, remoteMcp) as { mcpServers: Record<string, { command: string }> };
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
  const modelsAfter = readJson(harness.remote, remoteModels) as { providers: Record<string, { baseUrl: string }> };
  assert.equal(modelsAfter.providers.shared?.baseUrl, "http://shared");
  const mcpAfter = readJson(harness.remote, remoteMcp) as { mcpServers: Record<string, { command: string }> };
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
  const withLogin: NekCopySelection = { ...selection, providers: [], mcpServers: [], logins: ["anthropic"], defaults: false, compaction: false };
  // 目标机器的控制进程很快完成 OAuth。
  setTimeout(() => control.completeLogin(), 0);
  await harness.api.copy(LOCAL, REMOTE, withLogin, {});
  assert.deepEqual(
    control.commands.map((command) => command.type),
    ["auth_status", "auth_login"],
  );
  assert.equal(harness.remote.files.has(join(REMOTE_AGENT_DIR, "auth.json")), false, "auth.json is never written");
});

test("copy fails with a clear message when the login needs user input on the target", async () => {
  const control = new FakeControlClient();
  const harness = baseHarness();
  harness.useControl(control);
  const withLogin: NekCopySelection = { ...selection, providers: [], mcpServers: [], logins: ["anthropic"], defaults: false, compaction: false };
  setTimeout(() => {
    void control.pushPrompt({
      type: "extension_ui_request",
      id: "prompt-9",
      method: "structured",
      kind: "auth.prompt",
      payload: { provider: "anthropic", prompt: { type: "manual_code", message: "code" } },
    });
  }, 0);
  const error = await expectNekError(async () => await harness.api.copy(LOCAL, REMOTE, withLogin, {}), "validation");
  assert.match(error.message, /requires user input/);
});

test("copying onto the same target is rejected", async () => {
  const harness = baseHarness();
  const error = await expectNekError(
    async () => await harness.api.copy(LOCAL, LOCAL, { ...selection, providers: [], mcpServers: [] }, {}),
    "validation",
  );
  assert.match(error.message, /same target/);
});
