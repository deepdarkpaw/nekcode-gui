/**
 * nek GUI RPC 扩展协议（契约）。
 *
 * 这是 nekcode-gui 与 nek（`G:\coding\nekcode`）之间的共同事实来源：
 * - nek 侧在 `packages/coding-agent/src/modes/rpc/rpc-types.ts` 实现同形状的类型与处理；
 * - GUI 侧（`packages/services/src/nek-agent/`）按本文件消费。
 *
 * 线路格式：JSONL over stdio（只按 LF 分帧）。命令 `{ id?, type, ... }`，
 * 响应 `{ id?, type: "response", command, success, data? | error }`。
 * 本文件只描述在 nek 既有 RPC（docs/rpc-commands.md、docs/json.md、docs/rpc-extension-ui.md）之上
 * 新增的部分；既有命令与事件的形状以 nek 文档为准，镜像类型见 `./rpc.ts`。
 */

import type { NekMcpServerConfig, NekMode } from "./gui-extension-api.js";

/** 协议版本：任何不兼容的改动都要递增。GUI 要求 `protocolVersion === NEK_GUI_PROTOCOL_VERSION`。 */
export const NEK_GUI_PROTOCOL_VERSION = 1;

/** nek 的思考等级（与 `@earendil-works/pi-ai` 的 ModelThinkingLevel 一致）。 */
export type NekThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const NEK_THINKING_LEVELS: readonly NekThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 设置页暴露的四类端点（models.json 的 `api` 取值）。 */
export type NekEndpointApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export const NEK_ENDPOINT_APIS: readonly NekEndpointApi[] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

// ============================================================================
// 进程与启动
// ============================================================================

/**
 * `nek gui-info --json` 的输出（单个 JSON 对象，写到 stdout 后以 0 退出）。
 * GUI 据此免 shell 直接 spawn：`spawn(node.path, [...launch.args, "--mode", "rpc", ...])`。
 */
export interface NekGuiInfo {
  protocolVersion: number;
  /** nek 自身版本（package.json `nekConfig.version`），例如 "0.4.0"。 */
  nekVersion: string;
  /** 基线 pi 版本，例如 "1.0.2"。 */
  piVersion: string;
  node: { path: string; version: string };
  /**
   * 启动参数前缀：源码安装时为 `["--import", "<file URL of source-resolver.ts>", "<abs path of cli.ts>"]`，
   * 构建安装时为 `["<abs path of dist cli.js>"]`。GUI 原样放在 nek 参数之前。
   */
  launch: { args: string[] };
  /** 源码安装目录（`.nek-install-state.json` 所在目录）；无法确定时省略。 */
  installDir?: string;
  agentDir: string;
  sessionDir: string;
  platform: string;
  arch: string;
}

/**
 * 两种 RPC 进程：
 * - 会话进程：`nek --mode rpc [--session <path>] [--approve | --no-approve] ...`
 * - 控制进程：`nek --mode rpc --control`：不创建会话、不加载扩展与 MCP，
 *   只接受下面标注为 control 的命令；其他命令返回错误 `Command not available in control mode: <type>`。
 */
export type NekRpcProcessMode = "session" | "control";

// ============================================================================
// 新增命令（stdin）
// ============================================================================

export interface NekProviderDraft {
  api: NekEndpointApi;
  baseUrl: string;
  /** 字面量、`$ENV`/`${ENV}` 或 `!command`，与 models.json 的解析规则一致。 */
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

export type NekGuiRpcCommand =
  // ---- 运行时 [session + control] ----
  | { id?: string; type: "get_info" }
  | { id?: string; type: "reload" }
  | { id?: string; type: "validate_config"; cwd?: string }
  | { id?: string; type: "get_changelog"; sinceVersion?: string }
  // ---- 会话目录 [session + control] ----
  | { id?: string; type: "list_sessions"; cwd?: string; all?: boolean; limit?: number }
  | { id?: string; type: "delete_session"; sessionPath: string }
  | { id?: string; type: "rename_session"; sessionPath: string; name: string }
  | { id?: string; type: "read_session_snapshot"; sessionPath: string }
  | { id?: string; type: "import_session"; inputPath: string; cwd: string }
  // ---- 当前会话 [session] ----
  | { id?: string; type: "export_session"; format: "html" | "jsonl"; outputPath?: string }
  | { id?: string; type: "share_session" }
  | {
      id?: string;
      type: "navigate_tree";
      entryId: string;
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    }
  | { id?: string; type: "set_entry_label"; entryId: string; label?: string }
  // ---- 认证 [session + control] ----
  | { id?: string; type: "auth_status" }
  | { id?: string; type: "auth_login"; provider: string; method?: "oauth" | "api_key" }
  | { id?: string; type: "auth_logout"; provider: string }
  // ---- 模型 [session + control] ----
  | { id?: string; type: "get_model_catalog"; provider?: string; ids?: string[] }
  | { id?: string; type: "fetch_provider_models"; provider?: string; draft?: NekProviderDraft }
  | {
      id?: string;
      type: "test_provider";
      modelId: string;
      provider?: string;
      draft?: NekProviderDraft;
    }
  // ---- 项目信任 [session + control] ----
  | { id?: string; type: "get_project_trust"; cwd: string }
  | { id?: string; type: "set_project_trust"; cwd: string; trusted: boolean }
  // ---- 联网与 MCP 探测 [session + control] ----
  | { id?: string; type: "test_web_search"; query: string }
  | { id?: string; type: "mcp_test"; name?: string; config?: NekMcpServerConfig; cwd?: string }
  // ---- 输入框 @ 点名补全 [session + control（按 cwd）] ----
  | { id?: string; type: "get_mention_targets"; cwd?: string }
  // ---- 扩展通道 [session] ----
  | { id?: string; type: "extension_call"; method: string; params?: unknown };

export type NekGuiRpcCommandType = NekGuiRpcCommand["type"];

/** 控制进程接受的命令（既有命令中只有 `get_available_models` 在控制模式可用）。 */
export const NEK_CONTROL_COMMANDS: readonly string[] = [
  "get_info",
  "reload",
  "validate_config",
  "get_changelog",
  "list_sessions",
  "delete_session",
  "rename_session",
  "read_session_snapshot",
  "import_session",
  "auth_status",
  "auth_login",
  "auth_logout",
  "get_model_catalog",
  "fetch_provider_models",
  "test_provider",
  "get_project_trust",
  "set_project_trust",
  "test_web_search",
  "mcp_test",
  "get_mention_targets",
  "get_available_models",
];

// ============================================================================
// 新增命令的响应数据（`response.data`）
// ============================================================================

export interface NekInfo {
  protocolVersion: number;
  nekVersion: string;
  piVersion: string;
  mode: NekRpcProcessMode;
  agentDir: string;
  sessionDir: string;
  cwd: string;
  platform: string;
  nodeVersion: string;
}

/**
 * 输入框 `@` 补全中排在文件之前的点名目标（nek `core/mentions.ts`）：
 * `@agent:<type>` 点名子代理类型，`@skill:<name>` 把该 Skill 作为隐藏消息（`customType: "skill_mention"`，
 * `display: false`）附在用户消息之后；普通 `@path` 只是路径文本，不附带文件内容。
 */
export interface NekMentionTarget {
  kind: "agent" | "skill";
  name: string;
  description?: string;
  /** skill：SKILL.md 绝对路径（对话中 `@skill:name` 点击打开）。 */
  location?: string;
}

/** `get_mention_targets` 响应：agent 按 subagents section 顺序，skill 按 resourceLoader 顺序。 */
export interface NekMentionTargetsResult {
  targets: NekMentionTarget[];
}

export interface NekConfigDiagnostic {
  /** 绝对路径。 */
  file: string;
  severity: "error" | "warning";
  message: string;
}

export interface NekReloadResult {
  /** true：当前回合未结束，reload 已排队，在 `agent_settled` 后生效。 */
  deferred: boolean;
  diagnostics: NekConfigDiagnostic[];
}

export interface NekSessionSummary {
  path: string;
  id: string;
  /** 会话启动目录；旧会话可能为空字符串。 */
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  /** ISO 8601。 */
  createdAt: string;
  /** ISO 8601。 */
  modifiedAt: string;
  messageCount: number;
  /** 首条用户消息，截断到 200 字符。 */
  firstMessage: string;
  /** 会话锁被存活进程持有（终端 nek 或另一个 GUI 进程正在打开）。 */
  locked: boolean;
}

export interface NekSessionSnapshot {
  session: NekSessionSummary;
  /** 与 `get_entries` 相同形状（nek SessionEntry 的 JSON）。 */
  entries: unknown[];
  leafId: string | null;
  /** 与 `get_messages` 相同形状（当前叶子分支上的 AgentMessage 的 JSON）。 */
  messages: unknown[];
}

export interface NekAuthProviderStatus {
  provider: string;
  /** 展示名，例如 "Anthropic (Claude Pro/Max)"。 */
  name: string;
  /** 当前生效的凭据类型；none 表示未配置。 */
  kind: "oauth" | "api_key" | "env" | "none";
  /** auth_status 能提供的凭据健康状态；当前 nek 版本尚未提供 refresh_failed。 */
  state: "ok" | "expired" | "refresh_failed";
  /** 该 provider 支持的登录方式。 */
  loginMethods: Array<"oauth" | "api_key">;
  /** OAuth 访问令牌到期时间（ISO 8601）；nek 会自动刷新。 */
  expiresAt?: string;
}

export interface NekCatalogModel {
  provider: string;
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** `getSupportedThinkingLevels` 的结果。 */
  thinkingLevels: NekThinkingLevel[];
  thinkingLevelMap?: Partial<Record<NekThinkingLevel, string | null>>;
  input: Array<"text" | "image">;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface NekRemoteModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: NekThinkingLevel[];
  input?: Array<"text" | "image">;
}

/** 失败不是 RPC 错误，而是结构化结果，便于 GUI 映射 401/403/404。 */
export type NekFetchModelsResult =
  | { ok: true; endpoint: string; models: NekRemoteModel[] }
  | { ok: false; endpoint: string; status?: number; message: string };

export type NekTestProviderResult =
  | { ok: true; latencyMs: number }
  | { ok: false; status?: number; message: string };

export interface NekProjectTrustResource {
  kind:
    | "settings"
    | "mcp"
    | "extensions"
    | "skills"
    | "prompts"
    | "themes"
    | "agents"
    | "system_prompt"
    | "other";
  path: string;
}

export interface NekProjectTrust {
  cwd: string;
  /** null：没有记录（`defaultProjectTrust` 为 ask 时需要询问）。 */
  trusted: boolean | null;
  defaultProjectTrust: "ask" | "always" | "never";
  resources: NekProjectTrustResource[];
}

export type NekTestWebSearchResult =
  | { ok: true; latencyMs: number; resultCount: number }
  | { ok: false; message: string };

export type NekMcpTestResult =
  | { ok: true; latencyMs: number; tools: Array<{ name: string; description?: string }> }
  | { ok: false; message: string };

export interface NekGuiRpcResponseData {
  get_info: NekInfo;
  reload: NekReloadResult;
  validate_config: { diagnostics: NekConfigDiagnostic[] };
  get_changelog: { markdown: string };
  list_sessions: { sessions: NekSessionSummary[] };
  delete_session: Record<string, never>;
  rename_session: Record<string, never>;
  read_session_snapshot: NekSessionSnapshot;
  import_session: { sessionPath: string };
  export_session: { path: string };
  share_session: { url: string };
  navigate_tree: { cancelled: boolean; editorText?: string };
  set_entry_label: Record<string, never>;
  auth_status: { providers: NekAuthProviderStatus[] };
  auth_login: { provider: string };
  auth_logout: Record<string, never>;
  get_model_catalog: { models: NekCatalogModel[] };
  fetch_provider_models: NekFetchModelsResult;
  test_provider: NekTestProviderResult;
  get_project_trust: NekProjectTrust;
  set_project_trust: Record<string, never>;
  test_web_search: NekTestWebSearchResult;
  mcp_test: NekMcpTestResult;
  get_mention_targets: NekMentionTargetsResult;
  extension_call: { result: unknown };
}

// ============================================================================
// 新增事件与扩展 UI（stdout）
// ============================================================================

/** 扩展通过 `pi.emitRpcEvent(name, payload)` 发出；只在 RPC 模式输出。 */
export interface NekExtensionEvent {
  type: "extension_event";
  name: string;
  payload: unknown;
}

/** `auth_login` 期间 nek 把 AuthInteraction.notify 透传给 GUI。 */
export interface NekAuthEventRecord {
  type: "auth_event";
  provider: string;
  event:
    | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
    | { type: "auth_url"; url: string; instructions?: string }
    | {
        type: "device_code";
        userCode: string;
        verificationUri: string;
        intervalSeconds?: number;
        expiresInSeconds?: number;
      }
    | { type: "progress"; message: string };
}

/** 对话框被 nek 侧取消（signal 中止、超时、回合结束）时发出，GUI 关闭对应 id 的对话框。 */
export interface NekExtensionUiCancel {
  type: "extension_ui_cancel";
  id: string;
}

/**
 * 结构化交互请求：`ctx.ui.structured(kind, payload, opts)` 在 RPC 模式下输出。
 * GUI 回复 `{ type: "extension_ui_response", id, result }` 或 `{ ..., cancelled: true }`。
 */
export interface NekStructuredUiRequest<K extends string = string, P = unknown> {
  type: "extension_ui_request";
  id: string;
  method: "structured";
  kind: K;
  payload: P;
}

export type NekStructuredUiResponse =
  | { type: "extension_ui_response"; id: string; result: unknown }
  | { type: "extension_ui_response"; id: string; cancelled: true };

// ---- 结构化交互的 kind ----

/** `auth_login` 期间的输入提示（AuthInteraction.prompt）。result: `{ value: string }`。 */
export interface NekAuthPromptPayload {
  provider: string;
  prompt:
    | { type: "text"; message: string; placeholder?: string }
    | { type: "secret"; message: string; placeholder?: string }
    | {
        type: "select";
        message: string;
        options: Array<{ id: string; label: string; description?: string }>;
      }
    | { type: "manual_code"; message: string; placeholder?: string };
}

/** `ask_question` 工具（RPC 模式）。result: `NekAskQuestionResult`。 */
export interface NekAskQuestionPayload {
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    allow_multiple?: boolean;
    options: Array<{ id: string; label: string }>;
  }>;
}

export interface NekAskQuestionResult {
  answers: Array<{ questionId: string; selected: string[]; other?: string }>;
}

/** Plan 审阅（create_plan / update_plan 定稿后）。result: `{ action }`。 */
export interface NekPlanReviewPayload {
  path: string;
  revision: number;
  name: string;
  overview: string;
  markdown: string;
  todos: Array<{ id: string; content: string }>;
}

export type NekPlanReviewAction = "implement" | "implement_fresh" | "keep_planning" | "exit";

/** switch_mode 工具的审批。result: `{ approved: boolean }`。 */
export interface NekSwitchModePayload {
  from: NekMode;
  to: NekMode;
  explanation?: string;
}

export const NEK_STRUCTURED_KINDS = {
  authPrompt: "auth.prompt",
  askQuestion: "nek.ask_question",
  planReview: "nek.plan_review",
  switchMode: "nek.switch_mode",
} as const;

export * from "./gui-extension-api.js";
