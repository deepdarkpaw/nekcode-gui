/**
 * 设置中心各配置文件的数据形状（renderer ↔ host）。
 *
 * 与 `config-api.ts` 分开只为控制文件长度；两者一起通过 `@zcode/shared/nek-protocol` 导出。
 */
import type {
  NekAuthEventRecord,
  NekAuthPromptPayload,
  NekConfigDiagnostic,
  NekEndpointApi,
  NekThinkingLevel,
} from "./gui-rpc.js";
import type { RemoteTarget } from "../remoteTarget.js";
import type { NekMcpServerConfig } from "./gui-extension-api.js";

// ============================================================================
// 目标与通用
// ============================================================================

export type NekConfigTarget = { kind: "local" } | { kind: "remote"; connectionId: string };

export interface NekConfigTargetInfo {
  target: NekConfigTarget;
  /** 目标机器的主机名；本机由 host 使用 `os.hostname()` 填充。 */
  hostname: string;
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
  /** 端点类型；缺省时用服务商的 `api`（同一服务商下可以混用不同端点）。 */
  api?: NekEndpointApi | string;
  /** 请求地址；缺省时用服务商的 `baseUrl`。 */
  baseUrl?: string;
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

/**
 * 写入服务商：`apiKey` 为 undefined 表示保持原值不变；`{ remove: true }` 明确删除。
 * 空字符串不是删除指令，会被拒绝为校验错误。
 */
export interface NekProviderWrite extends Omit<NekProviderConfig, "apiKey" | "api"> {
  /** 缺省 = 不在服务商上设置端点（每个模型自带 `api`）；已有的服务商级 `api` 会被移除。 */
  api?: NekEndpointApi | string;
  apiKey?: string | { keep: true } | { remove: true };
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

export const NEK_WEB_SEARCH_PROVIDERS = ["tavily", "exa"] as const;

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
  webSearch?: { provider?: (typeof NEK_WEB_SEARCH_PROVIDERS)[number]; endpoint?: string; apiKey?: string; numResults?: number };
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
  /** 实际提供该条目的配置文件来源。 */
  path: string;
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

export interface NekAgentPresetsView extends NekConfigRevision {
  entries: NekAgentPresetEntry[];
  diagnostics: NekConfigDiagnostic[];
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

/**
 * 复制项决议键格式固定为 `<kind>:<id>`，例如 `provider:anthropic` 或 `mcpServer:filesystem`。
 */
export type NekCopyResolution = Record<string, "overwrite" | "skip">;

export type NekCopyItemStatus = "copied" | "skipped" | "failed";

export interface NekCopyItemResult {
  key: string;
  status: NekCopyItemStatus;
  /** `failed` 时是失败原因；`skipped` 时是跳过原因（可选）。 */
  error?: string;
}

export interface NekCopyResult {
  items: NekCopyItemResult[];
}

export interface NekBuiltinTool {
  name: string;
  description?: string;
  /** nek 的 `DEFAULT_ACTIVE_TOOL_NAMES` 里包含该工具（新会话默认启用）。 */
  defaultActive: boolean;
}

/**
 * 写配置后让运行中的 nek 进程重新载入的结果。
 *
 * `failures` 是进程级失败（进程起不来、RPC 超时……）：它不影响其他进程的 reload，
 * 但必须显示给用户并可重试，所以和"配置诊断"分开。
 */
export interface NekSessionReloadOutcome {
  reloaded: number;
  /** 当前回合未结束，已排队到回合结束后生效。 */
  deferred: number;
  diagnostics: NekConfigDiagnostic[];
  failures: Array<{ sessionKey: string; message: string }>;
}

export interface NekHostFingerprint {
  /** `SHA256:...` */
  fingerprint: string;
  keyType: string;
  /** epoch ms */
  addedAt: number;
}

export interface NekRemoteHost {
  /** 与 `NekConfigTarget.connectionId` 一致。 */
  connectionId: string;
  alias: string;
  /** 已去掉密码等 secret。 */
  target: RemoteTarget;
  authMethod: "agent" | "privateKey" | "password";
  fingerprints: NekHostFingerprint[];
  state: "connected" | "connecting" | "disconnected" | "failed";
  error?: string;
  nek: NekConfigTargetInfo["nek"];
}

export type NekHostTestResult =
  | { ok: true; latencyMs: number; fingerprint: string }
  | { ok: false; message: string };

export interface NekInstallOptions {
  channel?: "stable" | "dev";
  repoUrl?: string;
  nodeMirror?: string;
}

export type NekInstallResult =
  | { ok: true; version: string; cancelled?: false; manualCommand?: never }
  | { ok: false; cancelled: boolean; message: string; manualCommand: string };

export type NekLocalDetection =
  | { status: "ready"; version: string; path: string; protocolVersion: number }
  | { status: "not_installed" }
  | {
      status: "incompatible";
      version: string;
      path: string;
      protocolVersion: number;
      requiredProtocolVersion: number;
      requiredNekVersion?: string;
    }
  | { status: "failed"; message: string };

export interface NekOnboardingState {
  completedAt?: string;
  dismissedAt?: string;
}

export interface NekUpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface NekAppInfo {
  guiVersion: string;
  platform: string;
  logsDir: string;
}

export interface INekSettingsHostApi {
  listHosts(): Promise<NekRemoteHost[]>;
  saveHost(input: {
    connectionId?: string;
    alias: string;
    target: RemoteTarget;
  }): Promise<NekRemoteHost>;
  deleteHost(connectionId: string): Promise<void>;
  connectHost(connectionId: string): Promise<void>;
  disconnectHost(connectionId: string): Promise<void>;
  testHost(connectionId: string): Promise<NekHostTestResult>;
  installNek(
    connectionId: string,
    options: NekInstallOptions,
    onLog: (line: string) => void,
  ): Promise<NekInstallResult>;
  /** 取消该远程主机当前正在进行的安装或更新。 */
  cancelInstall(connectionId: string): Promise<void>;
  removeFingerprint(connectionId: string, fingerprint: string): Promise<void>;
  onHostsChanged(listener: () => void): () => void;
  openPath(target: NekConfigTarget, path: string): Promise<void>;
  /** 用系统浏览器打开登录链接；只接受 HTTP(S)，其他协议（含本地文件）报错拒绝。 */
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  getAppInfo(): Promise<NekAppInfo>;
  detectLocalNek(): Promise<NekLocalDetection>;
  installLocalNek(
    options: NekInstallOptions,
    onLog: (line: string) => void,
  ): Promise<NekInstallResult>;
  cancelLocalInstall(): Promise<void>;
  pickDirectory(): Promise<string | null>;
  getOnboardingState(): Promise<NekOnboardingState>;
  setOnboardingState(patch: Partial<NekOnboardingState>): Promise<void>;
  checkNekUpdate(target: NekConfigTarget): Promise<NekUpdateCheck>;
  runNekUpdate(
    target: NekConfigTarget,
    onLog: (line: string) => void,
  ): Promise<{ version: string }>;
  exportDiagnostics(): Promise<{ path: string; sizeBytes: number }>;
  openLogsDirectory(): Promise<void>;
}
