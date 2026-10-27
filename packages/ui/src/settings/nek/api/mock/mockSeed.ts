/**
 * mock 种子数据：一个本机目标 + 一个已连接远程 + 一个未连接远程；
 * 若干服务商与模型（含 401 / 404 演示用服务商）、MCP 服务器、子代理预设、登录状态。
 */
import type {
  NekCatalogModel,
  NekProviderConfig,
  NekSettingsView,
  NekYamlView,
} from "@zcode/shared/nek-protocol";
import { mockFile, type MockMachine } from "./mockMachine.js";

export const MOCK_REMOTE_CONNECTED = "conn-dev-box";
export const MOCK_REMOTE_DISCONNECTED = "conn-gpu-server";
export const MOCK_PROJECT_CWD = "/home/me/projects/nekcode-gui";

export const MOCK_DEFAULT_SETTINGS: NekSettingsView = {
  defaultThinkingLevel: "medium",
  defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "ast_grep", "web_search"],
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
    content: {
      thinkingMaxChars: 2000,
      thinkingTotalMaxChars: 20000,
      toolResultMaxChars: 4000,
      toolErrorMaxChars: 2000,
      toolArgumentMaxChars: 1000,
      pruneToolResults: true,
      protectedRecentTokens: 40000,
      protectedToolResults: 3,
    },
  },
  branchSummary: { reserveTokens: 16384, skipPrompt: false },
  retry: {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60000,
    provider: { timeoutMs: 600000, maxRetries: 2, maxRetryDelayMs: 60000 },
  },
  webSearch: { endpoint: "https://api.exa.ai", numResults: 5 },
  httpIdleTimeoutMs: 300000,
  transport: "auto",
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time",
  defaultProjectTrust: "ask",
  updateChannel: "stable",
};

export const MOCK_YAML_DEFAULTS: NekYamlView = {
  plan: { dir: ".nek/plans", shortcut: "alt+m" },
  todo: { settleReminder: true, widgetMaxLines: 8 },
  subagent: {
    maxConcurrent: 4,
    maxRetained: 20,
    awaitDefaultMs: 300000,
    awaitMaxMs: 1800000,
    finalTextMaxBytes: 16384,
  },
};

/** nek 内置模型目录（节选）。 */
export const MOCK_CATALOG: NekCatalogModel[] = [
  catalogModel("openai", "gpt-4.1", "GPT-4.1", "openai-responses", 1_047_576, 32_768, []),
  catalogModel("openai", "gpt-4.1-mini", "GPT-4.1 mini", "openai-responses", 1_047_576, 32_768, []),
  catalogModel(
    "deepseek",
    "deepseek-chat",
    "DeepSeek V3",
    "openai-completions",
    128_000,
    8_192,
    [],
  ),
  catalogModel(
    "deepseek",
    "deepseek-reasoner",
    "DeepSeek R1",
    "openai-completions",
    128_000,
    64_000,
    ["off", "high"],
  ),
  catalogModel(
    "anthropic",
    "claude-sonnet-4-5",
    "Claude Sonnet 4.5",
    "anthropic-messages",
    200_000,
    64_000,
    ["off", "minimal", "low", "medium", "high", "xhigh"],
  ),
  catalogModel(
    "anthropic",
    "claude-opus-4-1",
    "Claude Opus 4.1",
    "anthropic-messages",
    200_000,
    32_000,
    ["off", "minimal", "low", "medium", "high"],
  ),
  catalogModel("openai-codex", "gpt-5-codex", "GPT-5 Codex", "openai-responses", 400_000, 128_000, [
    "minimal",
    "low",
    "medium",
    "high",
  ]),
];

function catalogModel(
  provider: string,
  id: string,
  name: string,
  api: string,
  contextWindow: number,
  maxTokens: number,
  thinkingLevels: NekCatalogModel["thinkingLevels"],
): NekCatalogModel {
  return {
    provider,
    id,
    name,
    api,
    contextWindow,
    maxTokens,
    reasoning: thinkingLevels.length > 0,
    thinkingLevels,
    input: provider === "deepseek" ? ["text"] : ["text", "image"],
  };
}

const LOCAL_PROVIDERS: NekProviderConfig[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-demo-deepseek-1234",
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", contextWindow: 128_000, maxTokens: 8_192 },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek R1",
        contextWindow: 128_000,
        maxTokens: 64_000,
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
      },
    ],
  },
  {
    id: "anthropic-proxy",
    name: "Anthropic Proxy",
    api: "anthropic-messages",
    baseUrl: "https://claude-proxy.example.com",
    apiKey: "$ANTHROPIC_API_KEY",
    models: [
      {
        id: "claude-sonnet-4-5",
        contextWindow: 200_000,
        maxTokens: 64_000,
        input: ["text", "image"],
        reasoning: true,
        thinkingLevelMap: { max: null },
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ],
  },
  {
    id: "local-ollama",
    name: "Ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    models: [{ id: "qwen3:8b", contextWindow: 32_768, maxTokens: 8_192 }],
  },
  {
    id: "broken-key",
    name: "Broken Key (401)",
    api: "openai-completions",
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-bad-key",
    models: [],
  },
  {
    id: "no-list",
    name: "No Model List (404)",
    api: "openai-completions",
    baseUrl: "https://nolist.example.com/v1",
    apiKey: "sk-nolist-0000",
    models: [],
  },
];

function baseMachine(
  label: string,
  target: MockMachine["info"]["target"],
  agentDir: string,
  connected: boolean,
  detail?: string,
): MockMachine {
  return {
    info: {
      target,
      hostname: target.kind === "local" ? "DESKTOP-NEK" : label,
      label,
      detail,
      connected,
      nek: connected
        ? { state: "ready", version: "0.4.0", agentDir }
        : { state: "unknown", message: "not connected" },
    },
    agentDir,
    models: mockFile(`${agentDir}/models.json`, []),
    settings: mockFile(`${agentDir}/settings.json`, {}),
    projectSettings: new Map(),
    mcp: mockFile(`${agentDir}/mcp.json`, {}),
    projectMcp: new Map(),
    yaml: mockFile(`${agentDir}/nek.yaml`, {}, false),
    projectYaml: new Map(),
    presets: [
      {
        source: "builtin",
        revision: "builtin",
        preset: {
          name: "explore",
          description: "Read-only codebase exploration",
          readonly: true,
          tools: ["read", "grep", "find", "ls", "ast_grep"],
          instructions: "Explore the codebase and report findings. Never modify files.",
        },
      },
      {
        source: "builtin",
        revision: "builtin",
        preset: {
          name: "general",
          description: "General-purpose subagent",
          instructions: "Complete the delegated task end to end.",
        },
      },
    ],
    instructions: mockFile(`${agentDir}/AGENTS.md`, ""),
    projectInstructions: new Map(),
    auth: new Map([
      [
        "anthropic",
        {
          provider: "anthropic",
          name: "Anthropic (Claude Pro/Max)",
          kind: "none",
          state: "ok",
          loginMethods: ["oauth", "api_key"],
        },
      ],
      [
        "openai-codex",
        {
          provider: "openai-codex",
          name: "ChatGPT Plus/Pro (Codex)",
          kind: "none",
          state: "ok",
          loginMethods: ["oauth"],
        },
      ],
    ]),
    trust: new Map(),
    mcpAuth: new Map(),
  };
}

export function createLocalMachine(): MockMachine {
  const agentDir = "/home/me/.nek/agent";
  const machine = baseMachine("本机", { kind: "local" }, agentDir, true, "DESKTOP-NEK");
  machine.models.value = structuredClone(LOCAL_PROVIDERS);
  machine.settings.value = {
    defaultProvider: "deepseek",
    defaultModel: "deepseek-chat",
    defaultThinkingLevel: "medium",
    enabledModels: ["deepseek/deepseek-chat", "anthropic-proxy/claude-sonnet-4-5"],
    modelThinkingLevels: { "anthropic-proxy/claude-sonnet-4-5": "high" },
    compaction: { enabled: true },
  };
  machine.mcp.value = {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/me"],
      description: "Local file access",
    },
    github: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      oauth: { scope: "repo" },
      exposure: "direct",
    },
    sqlite: { command: "uvx", args: ["mcp-server-sqlite"], enabled: false },
    broken: { command: "missing-binary", description: "Fails to start (demo)" },
  };
  machine.projectMcp.set(
    MOCK_PROJECT_CWD,
    mockFile(`${MOCK_PROJECT_CWD}/.nek/mcp.json`, { github: { enabled: false } }),
  );
  machine.projectSettings.set(
    MOCK_PROJECT_CWD,
    mockFile(`${MOCK_PROJECT_CWD}/.nek/settings.json`, { defaultThinkingLevel: "high" }),
  );
  machine.presets.push(
    {
      source: "user",
      path: `${agentDir}/agents/reviewer.md`,
      revision: "rev-preset-reviewer",
      preset: {
        name: "reviewer",
        description: "Reviews diffs for bugs",
        model: "anthropic-proxy/claude-sonnet-4-5",
        thinking: "high",
        readonly: true,
        instructions: "Review the given changes. Report bugs with file:line references.",
      },
    },
    {
      source: "project",
      path: `${MOCK_PROJECT_CWD}/.nek/agents/docs-writer.md`,
      revision: "rev-preset-docs",
      preset: {
        name: "docs-writer",
        description: "Writes project documentation",
        tools: ["read", "write", "edit"],
        instructions: "Write concise documentation in the project's style.",
      },
    },
  );
  machine.instructions.value = "# Global instructions\n\n- Prefer early returns.\n";
  machine.auth.set("anthropic", {
    provider: "anthropic",
    name: "Anthropic (Claude Pro/Max)",
    kind: "oauth",
    state: "ok",
    loginMethods: ["oauth", "api_key"],
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
  });
  machine.trust.set(MOCK_PROJECT_CWD, null);
  return machine;
}

export function createRemoteMachines(): MockMachine[] {
  const devBox = baseMachine(
    "dev-box",
    { kind: "remote", connectionId: MOCK_REMOTE_CONNECTED },
    "/home/dev/.nek/agent",
    true,
    "dev@10.0.0.5:22",
  );
  devBox.models.value = [
    {
      id: "openrouter",
      name: "OpenRouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "$OPENROUTER_API_KEY",
      models: [{ id: "anthropic/claude-sonnet-4.5", contextWindow: 200_000, maxTokens: 64_000 }],
    },
  ];
  devBox.settings.value = {
    defaultProvider: "openrouter",
    defaultModel: "anthropic/claude-sonnet-4.5",
  };
  devBox.mcp.value = {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
  };
  const gpu = baseMachine(
    "gpu-server",
    { kind: "remote", connectionId: MOCK_REMOTE_DISCONNECTED },
    "/root/.nek/agent",
    false,
    "root@gpu.example.com:2222",
  );
  return [devBox, gpu];
}
