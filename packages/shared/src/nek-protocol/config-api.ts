/**
 * 设置中心 API 契约（renderer ↔ host）。
 *
 * - renderer（`packages/ui/src/settings/nek/**`）只通过本接口读写 nek 配置；
 * - host / 远端 gui-server 的实现位于 `packages/services/src/nek-agent/`，底层是 nekConfigService
 *   （直接读写目标机器的 `~/.nek/agent/*`）与控制进程（`nek --mode rpc --control`）。
 * - 每个方法都带 `target`：本机或某个已连接的远程连接。配置写在 nek 所在的那台机器上。
 *
 * 并发：读取返回 `revision`；写入携带读取时的 `revision`，文件已被外部修改时以
 * `NekConfigConflictError`（`code: "conflict"`）拒绝，界面提示"配置已在外部修改"。
 */
import type {
  NekAuthProviderStatus,
  NekCatalogModel,
  NekConfigDiagnostic,
  NekEndpointApi,
  NekFetchModelsResult,
  NekMcpExposure,
  NekMcpServerConfig,
  NekMcpServerStatus,
  NekMcpTestResult,
  NekProjectTrust,
  NekProviderDraft,
  NekTestProviderResult,
  NekTestWebSearchResult,
  NekThinkingLevel,
  NekAuthEventRecord,
  NekAuthPromptPayload,
} from "./gui-rpc.js";

// ============================================================================
// 目标与通用
// ============================================================================

export type NekConfigTarget = { kind: "local" } | { kind: "remote"; connectionId: string };

export interface NekConfigTargetInfo {
  target: NekConfigTarget;
  /** 显示名：本机为 "本机"/"This computer"，远程为主机别名。 */
  label: string;
  /** `user@host:port` 等。 */
  detail?: string;
  connected: boolean;
  /** 目标机器上 nek 的状态。 */
  nek:
    | { state: "ready"; version: string; agentDir: string }
    | { state: "not_installed" }
    | { state: "incompatible"; version: string; message: string }
    | { state: "unknown"; message?: string };
}

export type NekConfigScope = "global" | "project";

export interface NekConfigRevision {
  /** 不透明令牌（mtime + size + hash）；文件不存在时为 "absent"。 */
  revision: string;
}

export type NekConfigErrorCode =
  | "conflict"
  | "validation"
  | "not_connected"
  | "nek_unavailable"
  | "io";

/** 所有方法失败时抛出的错误形状（跨 RPC 序列化为 `{ code, message, details? }`）。 */
export interface NekConfigError {
  code: NekConfigErrorCode;
  message: string;
  /** validation：字段路径 → 错误文案。 */
  fieldErrors?: Record<string, string>;
}

// ============================================================================
// 服务商与模型（models.json）
// ============================================================================

export interface NekModelConfig {
  id: string;
  /** 显示名称（别名）。 */
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  /** 允许的思考等级 → 上游原始取值（null = 不支持）。 */
  thinkingLevelMap?: Partial<Record<NekThinkingLevel, string | null>>;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  /** 未被 GUI 识别、需原样保留的字段。 */
  extra?: Record<string, unknown>;
}

export interface NekProviderConfig {
  /** models.json 的键：`[a-z0-9-]+`，唯一。 */
  id: string;
  /** 显示名（models.json `name`）。 */
  name?: string;
  api: NekEndpointApi | string;
  baseUrl: string;
  /** 字面量、`$ENV`、`${ENV}` 或 `!command`；读取时字面量会被掩码为 `maskedApiKey`。 */
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models: NekModelConfig[];
  extra?: Record<string, unknown>;
}

/** 读取视图：API Key 不回显明文。 */
export interface NekProviderView extends Omit<NekProviderConfig, "apiKey"> {
  apiKey:
    | { kind: "none" }
    | { kind: "literal"; masked: string }
    | { kind: "env"; name: string }
    | { kind: "command"; command: string };
  /** 是否为 nek 内置服务商的覆盖（只改了 baseUrl 等）。 */
  overridesBuiltin: boolean;
}

export interface NekModelsConfigView extends NekConfigRevision {
  path: string;
  providers: NekProviderView[];
  diagnostics: NekConfigDiagnostic[];
}

/** 写入服务商：`apiKey` 为 undefined 表示保持原值不变。 */
export interface NekProviderWrite extends Omit<NekProviderConfig, "apiKey"> {
  apiKey?: string | { keep: true };
}

export interface NekProviderReferences {
  defaultModel: boolean;
  enabledModels: string[];
  compactionModel: boolean;
  modelThinkingLevels: string[];
  agentPresets: Array<{ name: string; path: string }>;
}

export interface NekProviderRenamePreview {
  from: string;
  to: string;
  references: NekProviderReferences;
}

// ============================================================================
// settings.json（GUI 编辑的子集）
// ============================================================================

export interface NekCompactionContentSettings {
  thinkingMaxChars?: number;
  thinkingTotalMaxChars?: number;
  toolResultMaxChars?: number;
  toolErrorMaxChars?: number;
  toolArgumentMaxChars?: number;
  pruneToolResults?: boolean;
  protectedRecentTokens?: number;
  protectedToolResults?: number;
}

export interface NekSettingsView {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: NekThinkingLevel;
  modelThinkingLevels?: Record<string, NekThinkingLevel>;
  enabledModels?: string[];
  defaultTools?: string[];
  shellPath?: string;
  shellCommandPrefix?: string;
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
    model?: string;
    thinkingLevel?: NekThinkingLevel;
    content?: NekCompactionContentSettings;
    modelOverrides?: Record<string, { reserveTokens?: number; keepRecentTokens?: number }>;
  };
  branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxAgentDelayMs?: number;
    provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
  };
  webSearch?: { endpoint?: string; apiKey?: string; numResults?: number };
  httpProxy?: string;
  httpIdleTimeoutMs?: number;
  transport?: string;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  defaultProjectTrust?: "ask" | "always" | "never";
  hideThinkingBlock?: boolean;
  updateChannel?: "stable" | "dev";
  /** 未在上面列出的键，原样保留。 */
  extra?: Record<string, unknown>;
}

export interface NekSettingsReadResult extends NekConfigRevision {
  path: string;
  scope: NekConfigScope;
  /** 该作用域文件里实际写了的值。 */
  values: NekSettingsView;
  /** 合并（全局 + 项目）后的生效值；用于显示"继承自全局"。 */
  effective: NekSettingsView;
  /** nek 默认值（用于"恢复默认"与占位显示）。 */
  defaults: NekSettingsView;
  diagnostics: NekConfigDiagnostic[];
}

/**
 * 设置补丁：只包含要改的键；`null` 表示删除该键（恢复默认）。
 * 嵌套对象按键合并（与 nek SettingsManager 的写法一致）。
 */
export type NekSettingsPatch = { [K in keyof NekSettingsView]?: NekSettingsView[K] | null };

// ============================================================================
// MCP（mcp.json）
// ============================================================================

export interface NekMcpServerEntry {
  name: string;
  scope: NekConfigScope;
  config: NekMcpServerConfig;
  /** 项目级条目只覆盖 enabled/exposure/toolExposure 时为 true。 */
  isOverride: boolean;
}

export interface NekMcpConfigView extends NekConfigRevision {
  path: string;
  scope: NekConfigScope;
  servers: NekMcpServerEntry[];
  diagnostics: NekConfigDiagnostic[];
}

/** 解析粘贴的 JSON（`{ mcpServers: {...} }` 或单个服务器），返回待导入项与冲突。 */
export interface NekMcpImportPreview {
  servers: Array<{ name: string; config: NekMcpServerConfig; conflict: boolean }>;
  errors: string[];
}

// ============================================================================
// nek.yaml 与子代理预设
// ============================================================================

export interface NekYamlView {
  plan: { dir: string; shortcut: string };
  todo: { settleReminder: boolean; widgetMaxLines: number };
  subagent: {
    maxConcurrent: number;
    maxRetained: number;
    awaitDefaultMs: number;
    awaitMaxMs: number;
    finalTextMaxBytes: number;
  };
}

export interface NekYamlReadResult extends NekConfigRevision {
  path: string;
  scope: NekConfigScope;
  values: Partial<{ [K in keyof NekYamlView]: Partial<NekYamlView[K]> }>;
  defaults: NekYamlView;
  diagnostics: NekConfigDiagnostic[];
}

export type NekYamlPatch = Partial<{
  [K in keyof NekYamlView]: Partial<{ [F in keyof NekYamlView[K]]: NekYamlView[K][F] | null }>;
}>;

export interface NekAgentPreset {
  name: string;
  description: string;
  model?: string;
  thinking?: NekThinkingLevel;
  contextWindow?: number;
  readonly?: boolean;
  tools?: string[];
  disallowedTools?: string[];
  isBackground?: boolean;
  autonomous?: boolean;
  /** frontmatter 之后的正文。 */
  instructions: string;
}

export interface NekAgentPresetEntry extends NekConfigRevision {
  source: "builtin" | "user" | "project";
  /** 内置预设没有文件路径，只读。 */
  path?: string;
  preset: NekAgentPreset;
}

// ============================================================================
// 账号登录
// ============================================================================

/** 登录过程中推送给界面的事件。 */
export type NekLoginEvent =
  | { type: "auth_event"; record: NekAuthEventRecord }
  | { type: "prompt"; promptId: string; payload: NekAuthPromptPayload }
  | { type: "prompt_cancelled"; promptId: string }
  | { type: "done"; provider: string }
  | { type: "failed"; message: string }
  | { type: "cancelled" };

export interface NekLoginSession {
  loginId: string;
  /** 远程目标时，host 为 OAuth 回调建立的本机端口转发（例如 53692、1455）。 */
  forwardedPorts: number[];
}

// ============================================================================
// 复制到远程
// ============================================================================

export interface NekCopySelection {
  providers: string[];
  /** OAuth 登录（auth.json 条目），默认不勾选。 */
  logins: string[];
  mcpServers: string[];
  defaults: boolean;
  compaction: boolean;
}

export interface NekCopyPreview {
  items: Array<{
    kind: "provider" | "login" | "mcpServer" | "defaults" | "compaction";
    id: string;
    /** 目标机器已存在同名项。 */
    conflict: boolean;
  }>;
}

export type NekCopyResolution = Record<string, "overwrite" | "skip">;

// ============================================================================
// API
// ============================================================================

export interface INekConfigApi {
  // ---- 目标 ----
  listTargets(): Promise<NekConfigTargetInfo[]>;

  // ---- 服务商与模型 ----
  readModelsConfig(target: NekConfigTarget): Promise<NekModelsConfigView>;
  saveProvider(
    target: NekConfigTarget,
    provider: NekProviderWrite,
    options: { revision: string; isNew: boolean },
  ): Promise<NekConfigRevision>;
  deleteProvider(
    target: NekConfigTarget,
    providerId: string,
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  getProviderReferences(
    target: NekConfigTarget,
    providerId: string,
  ): Promise<NekProviderReferences>;
  previewProviderRename(
    target: NekConfigTarget,
    from: string,
    to: string,
  ): Promise<NekProviderRenamePreview>;
  renameProvider(
    target: NekConfigTarget,
    from: string,
    to: string,
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  saveModel(
    target: NekConfigTarget,
    providerId: string,
    model: NekModelConfig,
    options: { revision: string; previousId?: string },
  ): Promise<NekConfigRevision>;
  addModels(
    target: NekConfigTarget,
    providerId: string,
    models: NekModelConfig[],
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  deleteModel(
    target: NekConfigTarget,
    providerId: string,
    modelId: string,
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  reorderModels(
    target: NekConfigTarget,
    providerId: string,
    modelIds: string[],
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  fetchProviderModels(
    target: NekConfigTarget,
    source: { providerId: string } | { draft: NekProviderDraft },
  ): Promise<NekFetchModelsResult>;
  testProvider(
    target: NekConfigTarget,
    source: { providerId: string } | { draft: NekProviderDraft },
    modelId: string,
  ): Promise<NekTestProviderResult>;
  getModelCatalog(target: NekConfigTarget, ids?: string[]): Promise<NekCatalogModel[]>;
  /** 当前目标上可用的模型（`provider/id`），用于默认模型、压缩模型、子代理模型选择。 */
  listAvailableModels(target: NekConfigTarget): Promise<NekCatalogModel[]>;

  // ---- settings.json ----
  readSettings(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekSettingsReadResult>;
  patchSettings(
    target: NekConfigTarget,
    scope: NekConfigScope,
    patch: NekSettingsPatch,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  testWebSearch(target: NekConfigTarget, query: string): Promise<NekTestWebSearchResult>;

  // ---- 账号登录 ----
  getAuthStatus(target: NekConfigTarget): Promise<NekAuthProviderStatus[]>;
  /** 开始登录；进度经 `onLoginEvent` 推送。 */
  startLogin(target: NekConfigTarget, provider: string): Promise<NekLoginSession>;
  answerLoginPrompt(loginId: string, promptId: string, value: string): Promise<void>;
  cancelLogin(loginId: string): Promise<void>;
  onLoginEvent(loginId: string, listener: (event: NekLoginEvent) => void): () => void;
  logout(target: NekConfigTarget, provider: string): Promise<void>;

  // ---- MCP ----
  readMcpConfig(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekMcpConfigView>;
  saveMcpServer(
    target: NekConfigTarget,
    scope: NekConfigScope,
    entry: { name: string; config: NekMcpServerConfig; previousName?: string },
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  setMcpServerOverride(
    target: NekConfigTarget,
    name: string,
    override: {
      enabled?: boolean;
      exposure?: NekMcpExposure;
      toolExposure?: Record<string, NekMcpExposure>;
    },
    options: { revision: string; scope: NekConfigScope; cwd?: string },
  ): Promise<NekConfigRevision>;
  deleteMcpServer(
    target: NekConfigTarget,
    scope: NekConfigScope,
    name: string,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  previewMcpImport(
    target: NekConfigTarget,
    scope: NekConfigScope,
    json: string,
    cwd?: string,
  ): Promise<NekMcpImportPreview>;
  testMcpServer(
    target: NekConfigTarget,
    source: { name: string; cwd?: string } | { config: NekMcpServerConfig },
  ): Promise<NekMcpTestResult>;
  /** 来自当前目标上运行中的会话进程；没有会话进程时返回 undefined。 */
  getMcpStatus(target: NekConfigTarget, cwd?: string): Promise<NekMcpServerStatus[] | undefined>;
  mcpServerAction(
    target: NekConfigTarget,
    name: string,
    action: "reconnect" | "login" | "logout",
    cwd?: string,
  ): Promise<NekMcpServerStatus>;

  // ---- nek.yaml、子代理预设、指令 ----
  readNekYaml(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekYamlReadResult>;
  patchNekYaml(
    target: NekConfigTarget,
    scope: NekConfigScope,
    patch: NekYamlPatch,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  listAgentPresets(target: NekConfigTarget, cwd?: string): Promise<NekAgentPresetEntry[]>;
  saveAgentPreset(
    target: NekConfigTarget,
    scope: NekConfigScope,
    preset: NekAgentPreset,
    options: { revision: string; previousName?: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  deleteAgentPreset(
    target: NekConfigTarget,
    scope: NekConfigScope,
    name: string,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  readInstructions(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekConfigRevision & { path: string; content: string }>;
  writeInstructions(
    target: NekConfigTarget,
    scope: NekConfigScope,
    content: string,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  listResources(
    target: NekConfigTarget,
    cwd?: string,
  ): Promise<{
    skills: Array<{ name: string; path: string; description?: string }>;
    prompts: Array<{ name: string; path: string; description?: string }>;
    extensions: Array<{ name: string; path: string }>;
    directories: { agentDir: string; projectDir?: string };
  }>;

  // ---- 项目信任 ----
  getProjectTrust(target: NekConfigTarget, cwd: string): Promise<NekProjectTrust>;
  setProjectTrust(target: NekConfigTarget, cwd: string, trusted: boolean): Promise<void>;

  // ---- 校验与重载 ----
  validate(target: NekConfigTarget, cwd?: string): Promise<NekConfigDiagnostic[]>;
  /** 写入后由实现自动调用；也供"重新载入"按钮使用。返回仍需等待本轮结束的会话数。 */
  reloadRunningSessions(
    target: NekConfigTarget,
  ): Promise<{ reloaded: number; deferred: number; diagnostics: NekConfigDiagnostic[] }>;

  // ---- 外部修改 ----
  /** 监视目标机器的配置文件（本机 fs.watch，远程每 5 s stat），变化时回调。 */
  watch(
    target: NekConfigTarget,
    listener: (change: { file: string; revision: string }) => void,
  ): () => void;

  // ---- 复制到远程 ----
  previewCopy(
    from: NekConfigTarget,
    to: NekConfigTarget,
    selection: NekCopySelection,
  ): Promise<NekCopyPreview>;
  copy(
    from: NekConfigTarget,
    to: NekConfigTarget,
    selection: NekCopySelection,
    resolution: NekCopyResolution,
  ): Promise<void>;
}
