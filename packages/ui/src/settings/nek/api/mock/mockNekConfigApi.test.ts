import { describe, expect, it } from "vitest";
import { MockNekConfigApi } from "./mockNekConfigApi.js";
import { MOCK_PROJECT_CWD, MOCK_REMOTE_CONNECTED, MOCK_REMOTE_DISCONNECTED } from "./mockSeed.js";

const LOCAL = { kind: "local" } as const;
const REMOTE = { kind: "remote", connectionId: MOCK_REMOTE_CONNECTED } as const;

describe("MockNekConfigApi", () => {
  it("exposes one local, one connected and one disconnected remote target", async () => {
    const api = new MockNekConfigApi();
    const targets = await api.listTargets();
    expect(targets.map((target) => [target.label, target.connected])).toEqual([
      ["本机", true],
      ["dev-box", true],
      ["gpu-server", false],
    ]);
    await expect(
      api.readSettings({ kind: "remote", connectionId: MOCK_REMOTE_DISCONNECTED }, "global"),
    ).rejects.toMatchObject({ code: "not_connected" });
  });

  it("rejects stale revisions with a conflict error", async () => {
    const api = new MockNekConfigApi();
    const { revision } = await api.readSettings(LOCAL, "global");
    await api.patchSettings(LOCAL, "global", { httpProxy: "a" }, { revision });
    await expect(
      api.patchSettings(LOCAL, "global", { httpProxy: "b" }, { revision }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("masks literal API keys and keeps them on { keep: true }", async () => {
    const api = new MockNekConfigApi();
    const view = await api.readModelsConfig(LOCAL);
    const deepseek = view.providers.find((provider) => provider.id === "deepseek")!;
    expect(deepseek.apiKey).toEqual({ kind: "literal", masked: "••••1234" });
    const { apiKey: _apiKey, overridesBuiltin: _builtin, ...rest } = deepseek;
    await api.saveProvider(
      LOCAL,
      { ...rest, name: "DS", apiKey: { keep: true } },
      { revision: view.revision, isNew: false },
    );
    expect(api.machines.get("local")?.models.value[0]?.apiKey).toBe("sk-demo-deepseek-1234");
  });

  it("returns 401 / 404 / mixed metadata from fetchProviderModels", async () => {
    const api = new MockNekConfigApi();
    expect(await api.fetchProviderModels(LOCAL, { providerId: "broken-key" })).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(await api.fetchProviderModels(LOCAL, { providerId: "no-list" })).toMatchObject({
      ok: false,
      status: 404,
    });
    const result = await api.fetchProviderModels(LOCAL, {
      providerId: "anthropic-proxy",
      draft: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    });
    expect(result.ok && result.models.some((model) => model.contextWindow === undefined)).toBe(
      true,
    );
    expect(result.ok && result.models.some((model) => model.contextWindow !== undefined)).toBe(
      true,
    );
  });

  it("previews renames with every reference and applies them", async () => {
    const api = new MockNekConfigApi();
    const preview = await api.previewProviderRename(LOCAL, "anthropic-proxy", "claude");
    expect(preview.references).toMatchObject({
      defaultModel: false,
      enabledModels: ["anthropic-proxy/claude-sonnet-4-5"],
      modelThinkingLevels: ["anthropic-proxy/claude-sonnet-4-5"],
      agentPresets: [{ name: "reviewer" }],
    });
    const { revision } = await api.readModelsConfig(LOCAL);
    await api.renameProvider(LOCAL, "anthropic-proxy", "claude", { revision });
    const presets = await api.listAgentPresets(LOCAL);
    expect(presets.entries.find((entry) => entry.preset.name === "reviewer")?.preset.model).toBe(
      "claude/claude-sonnet-4-5",
    );
  });

  it("parses Claude Desktop / Cursor JSON and flags name conflicts", async () => {
    const api = new MockNekConfigApi();
    const preview = await api.previewMcpImport(
      LOCAL,
      "global",
      JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx" },
          linear: { url: "https://mcp.linear.app/sse" },
          bad: {},
        },
      }),
    );
    expect(preview.servers.map((server) => [server.name, server.conflict])).toEqual([
      ["filesystem", true],
      ["linear", false],
    ]);
    expect(preview.errors).toHaveLength(1);
  });

  it("merges project MCP overrides on top of global servers", async () => {
    const api = new MockNekConfigApi();
    const project = await api.readMcpConfig(LOCAL, "project", MOCK_PROJECT_CWD);
    expect(project.servers).toEqual([
      expect.objectContaining({
        name: "github",
        isOverride: true,
        config: expect.objectContaining({ enabled: false }),
      }),
    ]);
  });

  it("copies selected items to a remote with per-item conflict resolution", async () => {
    const api = new MockNekConfigApi();
    const selection = {
      providers: ["deepseek"],
      logins: [],
      mcpServers: ["filesystem"],
      defaults: false,
      compaction: false,
    };
    const preview = await api.previewCopy(LOCAL, REMOTE, selection);
    expect(preview.items).toEqual([
      { kind: "provider", id: "deepseek", conflict: false },
      { kind: "mcpServer", id: "filesystem", conflict: true },
    ]);
    await api.copy(LOCAL, REMOTE, selection, { "mcpServer:filesystem": "skip" });
    const remote = api.machines.get(`remote:${MOCK_REMOTE_CONNECTED}`)!;
    expect(remote.models.value.map((provider) => provider.id)).toContain("deepseek");
    expect(remote.mcp.value.filesystem).not.toHaveProperty("description");
  });
});

describe("MockNekConfigApi v2 contract", () => {
  it("returns builtin tools with the nek default-active flags", async () => {
    const api = new MockNekConfigApi();
    const tools = await api.listBuiltinTools(LOCAL);
    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "powershell",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "ast_grep",
      "web_search",
    ]);
    expect(tools.find((tool) => tool.name === "powershell")?.defaultActive).toBe(false);
  });

  it("returns preset entries, diagnostics and a directory revision", async () => {
    const api = new MockNekConfigApi();
    const view = await api.listAgentPresets(LOCAL, MOCK_PROJECT_CWD);
    expect(view.entries.map((entry) => entry.preset.name)).toContain("docs-writer");
    expect(view.diagnostics).toMatchObject([
      { file: expect.stringContaining("broken-preset.md"), severity: "error" },
    ]);
    expect(view.revision.length).toBeGreaterThan(0);
    // 不带 cwd 时看不到项目预设，也看不到项目级诊断
    const global = await api.listAgentPresets(LOCAL);
    expect(global.entries.map((entry) => entry.preset.name)).not.toContain("docs-writer");
  });

  it("deletes a provider key only for { remove: true }", async () => {
    const api = new MockNekConfigApi();
    const view = await api.readModelsConfig(LOCAL);
    const deepseek = view.providers.find((provider) => provider.id === "deepseek")!;
    const { apiKey: _apiKey, overridesBuiltin: _builtin, ...rest } = deepseek;
    await expect(
      api.saveProvider(LOCAL, { ...rest, apiKey: "" }, { revision: view.revision, isNew: false }),
    ).rejects.toMatchObject({ code: "validation" });
    await api.saveProvider(
      LOCAL,
      { ...rest, apiKey: { remove: true } },
      { revision: view.revision, isNew: false },
    );
    const after = await api.readModelsConfig(LOCAL);
    expect(after.providers.find((provider) => provider.id === "deepseek")?.apiKey).toEqual({
      kind: "none",
    });
  });

  it("reports per-item copy results, including forced failures", async () => {
    const api = new MockNekConfigApi();
    api.failCopyItem("provider:deepseek", "disk full");
    const result = await api.copy(
      LOCAL,
      REMOTE,
      {
        providers: ["deepseek"],
        logins: [],
        mcpServers: ["filesystem"],
        defaults: false,
        compaction: false,
      },
      {},
    );
    expect(result.items).toEqual([
      { key: "provider:deepseek", status: "failed", error: "disk full" },
      { key: "mcpServer:filesystem", status: "skipped" },
    ]);
  });

  it("publishes watch changes with the scope of the written file", async () => {
    const api = new MockNekConfigApi();
    const changes: Array<{ file: string; scope: string }> = [];
    const unsubscribe = api.watch(LOCAL, (change) => changes.push(change), MOCK_PROJECT_CWD);
    const project = await api.readMcpConfig(LOCAL, "project", MOCK_PROJECT_CWD);
    await api.setMcpServerOverride(
      LOCAL,
      "github",
      { enabled: true },
      { revision: project.revision, scope: "project", cwd: MOCK_PROJECT_CWD },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    unsubscribe();
    expect(changes).toMatchObject([
      { file: `${MOCK_PROJECT_CWD}/.nek/mcp.json`, scope: "project" },
    ]);
  });

  it("emits reload results with process failures", async () => {
    const api = new MockNekConfigApi();
    const results: Array<{ failures: Array<{ sessionKey: string; message: string }> }> = [];
    const unsubscribe = api.onReloadResult(LOCAL, (result) => results.push(result));
    api.simulateReloadResult(LOCAL, {
      failures: [{ sessionKey: "s1", message: "stdin closed" }],
    });
    unsubscribe();
    expect(results).toEqual([
      {
        reloaded: 1,
        deferred: 0,
        diagnostics: [],
        failures: [{ sessionKey: "s1", message: "stdin closed" }],
      },
    ]);
  });
});
