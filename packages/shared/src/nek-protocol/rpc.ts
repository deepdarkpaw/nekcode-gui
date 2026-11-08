/**
 * nek 既有 RPC 的 JSON 形状镜像 + 与 `gui-rpc.ts` 合并的完整联合。
 *
 * 事实来源：`packages/coding-agent/src/modes/rpc/rpc-types.ts` 与
 * `docs/rpc-commands.md`、`docs/json.md`、`docs/rpc-extension-ui.md`。本文件不 import nek 的任何包，
 * 只描述线上 JSON；`gui-rpc.ts` 是 GUI 与 nek 共同维护的新增契约，这里只做合并。
 *
 * 线路约定：命令 `{ id?, type, ... }`；响应 `{ id?, type: "response", command, success, data? | error }`。
 * 事件没有 `id`（`bash_execution_update` 例外，它带发起命令的 id）。
 */
import type {
  NekEndpointApi,
  NekGuiRpcCommand,
  NekGuiRpcResponseData,
  NekMode,
  NekThinkingLevel,
} from "./gui-rpc.js";
import type { NekMentionTargetInfo } from "./mentions.js";
import type {
  NekAgentMessage,
  NekImageContent,
  NekPromptAttachment,
  NekSessionEntry,
  NekSessionTreeNode,
  NekUsage,
} from "./rpc-messages.js";

// ============================================================================
// Model / 会话状态 / 统计
// ============================================================================

export interface NekModelCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface NekModelCost extends NekModelCostRates {
  tiers?: Array<NekModelCostRates & { inputTokensAbove: number }>;
}

/**
 * `Model` 的线上形状（`@earendil-works/pi-ai`）。GUI 只读展示与选择所需的字段，
 * 其余字段（`compat`、`samplingParams`、provider 私有项）按不透明处理。
 */
export interface NekModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  input: Array<"text" | "image">;
  cost: NekModelCost;
  headers?: Record<string, string>;
  type?: "chat";
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<NekThinkingLevel, string | null>>;
  promptCache?: { short?: number; long?: number };
  contextWindow?: number;
  maxTokens?: number;
  inputLimits?: unknown;
  samplingParams?: Record<string, unknown>;
  samplingParamsByThinkingLevel?: Record<string, Record<string, unknown>>;
  compat?: unknown;
}

/** 命令来源（`get_commands`、`RpcSlashCommand.sourceInfo`）。 */
export interface NekSourceInfo {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

/** 可以经 `prompt` 调用的斜杠命令。 */
export interface NekRpcSlashCommand {
  /** 不带前导斜杠。 */
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: NekSourceInfo;
}

/** `get_state` 的数据。 */
export interface NekRpcSessionState {
  model?: NekModel;
  thinkingLevel: NekThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

/** 最近一次模型调用的上下文用量。压缩刚结束时 `tokens` 为 null。 */
export interface NekContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** `get_session_stats` 的数据。 */
export interface NekSessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: NekContextUsage;
}

/** `bash` 命令的数据：合并后的 stdout+stderr（可能被截断）。 */
export interface NekBashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

/** `compact` 命令的数据。 */
export interface NekCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  usage?: NekUsage;
  details?: unknown;
}

/** `prompt` 的处置结果：`handled` 表示没有启动本轮（斜杠命令等）。 */
export type NekQueuedInputDisposition = "handled" | "queued";
export type NekPromptDisposition = NekQueuedInputDisposition | "started";

export type NekCompactionReason = "manual" | "threshold" | "overflow";

// ============================================================================
// 命令（stdin）
// ============================================================================

/** nek 既有命令。`--mode rpc` 会话进程接受全部；`--control` 只接受 `get_available_models`。 */
export type NekSessionRpcCommand =
  // Prompting
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: NekImageContent[];
      attachments?: NekPromptAttachment[];
      streamingBehavior?: "steer" | "followUp";
    }
  | {
      id?: string;
      type: "steer";
      message: string;
      images?: NekImageContent[];
      attachments?: NekPromptAttachment[];
    }
  | {
      id?: string;
      type: "follow_up";
      message: string;
      images?: NekImageContent[];
      attachments?: NekPromptAttachment[];
    }
  | { id?: string; type: "abort" }
  | { id?: string; type: "clear_queue" }
  | { id?: string; type: "new_session"; parentSession?: string }
  // State
  | { id?: string; type: "get_state" }
  // Model
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  // Thinking
  | { id?: string; type: "set_thinking_level"; level: NekThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_available_thinking_levels" }
  // Queue modes
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  // Compaction
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  // Retry
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }
  // Bash
  | { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
  | { id?: string; type: "abort_bash" }
  // Session
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "clone" }
  | { id?: string; type: "get_fork_messages" }
  // 分页：`limit` 取最新的一页，配 `beforeEntryId` 取比该条目更旧的一页；`hasMore` 说明还有更旧的条目。
  | { id?: string; type: "get_entries"; since?: string; limit?: number; beforeEntryId?: string }
  | { id?: string; type: "get_tree" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  // Messages
  | { id?: string; type: "get_messages" }
  // Commands
  | { id?: string; type: "get_commands" };

/**
 * `@agent:` / `@skill:` 点名补全的目标列表。
 *
 * 契约先落在镜像层（`gui-rpc.ts` 由主代理稍后同步）：GUI 启动会话/打开项目后取一次，
 * 之后由 `reload` 触发刷新。返回的目标带 `location`，供 UI 打开 agent 预设或 `SKILL.md`。
 */
export type NekMentionRpcCommand = { id?: string; type: "get_mention_targets" };

/** 完整命令联合：nek 既有命令 + 点名目标 + `gui-rpc.ts` 的 GUI 扩展命令。 */
export type NekRpcCommand = NekSessionRpcCommand | NekMentionRpcCommand | NekGuiRpcCommand;

export type NekRpcCommandType = NekRpcCommand["type"];
export type NekSessionRpcCommandType = NekSessionRpcCommand["type"];
/** `gui-rpc.ts` 的 `NekGuiRpcCommandType` 由 `export *` 直接透出，这里不重复定义。 */

/** 取某个命令类型的命令载荷（用于 `call()` 的参数类型）。 */
export type NekRpcCommandOfType<T extends NekRpcCommandType> = Extract<NekRpcCommand, { type: T }>;

// ============================================================================
// 响应（stdout）
// ============================================================================

/** `cycle_model` 的数据：null 表示没有可切换的模型。 */
export interface NekCycleModelResult {
  model: NekModel;
  thinkingLevel: NekThinkingLevel;
  isScoped: boolean;
}

/**
 * 命令类型 → 响应 `data` 的映射。
 *
 * 无数据的命令显式标 `undefined`；映射表里没有的类型统一按 `unknown` 处理，
 * 这样 nek 新增命令时 GUI 不会因为类型收窄而误判"一定有数据"。
 */
export interface NekRpcResponseDataMap {
  // ---- 既有命令 ----
  prompt: { disposition: NekPromptDisposition };
  steer: { disposition: NekQueuedInputDisposition };
  follow_up: { disposition: NekQueuedInputDisposition };
  abort: undefined;
  clear_queue: { steering: string[]; followUp: string[] };
  new_session: { cancelled: boolean };
  get_state: NekRpcSessionState;
  set_model: NekModel;
  cycle_model: NekCycleModelResult | null;
  get_available_models: { models: NekModel[] };
  set_thinking_level: undefined;
  cycle_thinking_level: { level: NekThinkingLevel } | null;
  get_available_thinking_levels: { levels: NekThinkingLevel[] };
  set_steering_mode: undefined;
  set_follow_up_mode: undefined;
  compact: NekCompactionResult;
  set_auto_compaction: undefined;
  set_auto_retry: undefined;
  abort_retry: undefined;
  bash: NekBashResult;
  abort_bash: undefined;
  get_session_stats: NekSessionStats;
  export_html: { path: string };
  switch_session: { cancelled: boolean };
  fork: { text: string; cancelled: boolean };
  clone: { cancelled: boolean };
  get_fork_messages: { messages: Array<{ entryId: string; text: string }> };
  get_entries: { entries: NekSessionEntry[]; leafId: string | null; hasMore?: boolean };
  get_tree: { tree: NekSessionTreeNode[]; leafId: string | null };
  get_last_assistant_text: { text: string | null };
  set_session_name: undefined;
  get_messages: { messages: NekAgentMessage[] };
  get_commands: { commands: NekRpcSlashCommand[] };
  // ---- 点名补全 ----
  get_mention_targets: { targets: NekMentionTargetInfo[] };
  // ---- gui-rpc 新增命令 ----
  get_info: NekGuiRpcResponseData["get_info"];
  reload: NekGuiRpcResponseData["reload"];
  validate_config: NekGuiRpcResponseData["validate_config"];
  get_changelog: NekGuiRpcResponseData["get_changelog"];
  list_builtin_tools: NekGuiRpcResponseData["list_builtin_tools"];
  list_sessions: NekGuiRpcResponseData["list_sessions"];
  delete_session: NekGuiRpcResponseData["delete_session"];
  rename_session: NekGuiRpcResponseData["rename_session"];
  read_session_snapshot: NekGuiRpcResponseData["read_session_snapshot"];
  import_session: NekGuiRpcResponseData["import_session"];
  export_session: NekGuiRpcResponseData["export_session"];
  share_session: NekGuiRpcResponseData["share_session"];
  navigate_tree: NekGuiRpcResponseData["navigate_tree"];
  set_entry_label: NekGuiRpcResponseData["set_entry_label"];
  auth_status: NekGuiRpcResponseData["auth_status"];
  auth_login: NekGuiRpcResponseData["auth_login"];
  auth_logout: NekGuiRpcResponseData["auth_logout"];
  get_model_catalog: NekGuiRpcResponseData["get_model_catalog"];
  fetch_provider_models: NekGuiRpcResponseData["fetch_provider_models"];
  test_provider: NekGuiRpcResponseData["test_provider"];
  get_project_trust: NekGuiRpcResponseData["get_project_trust"];
  set_project_trust: NekGuiRpcResponseData["set_project_trust"];
  test_web_search: NekGuiRpcResponseData["test_web_search"];
  mcp_test: NekGuiRpcResponseData["mcp_test"];
  extension_call: NekGuiRpcResponseData["extension_call"];
}

/**
 * 命令类型 → 响应数据。未在映射表里的命令解析为 `unknown`。
 * 注意 `undefined` 表示"成功响应不带 data"。
 */
export type NekRpcResponseData = {
  [K in NekRpcCommandType]: K extends keyof NekRpcResponseDataMap
    ? NekRpcResponseDataMap[K]
    : unknown;
};

export type NekRpcResponseDataFor<T extends NekRpcCommandType> = NekRpcResponseData[T];

type NekRpcResponseDataField<D> = [D] extends [undefined] ? { data?: undefined } : { data: D };

/** 成功响应：`command` 与 `data` 按命令类型配对。 */
export type NekRpcSuccessResponse = {
  [K in NekRpcCommandType]: {
    id?: string;
    type: "response";
    command: K;
    success: true;
  } & NekRpcResponseDataField<NekRpcResponseData[K]>;
}[NekRpcCommandType];

/** 失败响应：任何命令都可能失败，`command` 退化为 string。 */
export interface NekRpcErrorResponse {
  id?: string;
  type: "response";
  command: string;
  success: false;
  error: string;
}

export type NekRpcResponse = NekRpcSuccessResponse | NekRpcErrorResponse;

// ============================================================================
// 便捷收窄
// ============================================================================

/** 是否成功响应（类型守卫，用于 `NekRpcResponse` 收窄）。 */
export function isNekRpcSuccessResponse(
  response: NekRpcResponse,
): response is NekRpcSuccessResponse {
  return response.success;
}

/** 取当前协作模式：nek 的 `Mode` 与 v4 `config.mode` 的桥。 */
export type NekCollaborationMode = NekMode;

/** 端点类型的窄化别名（models.json 的 `api` 取值）。 */
export type NekModelApi = NekEndpointApi | (string & {});

// ============================================================================
// 聚合导出：`rpc.ts` 是本模块的唯一入口
// ============================================================================

export * from "./rpc-messages.js";
export * from "./rpc-events.js";
