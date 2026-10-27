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
      draft: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", apiKey: "sk-ok" },
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
    expect(presets.find((entry) => entry.preset.name === "reviewer")?.preset.model).toBe(
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
