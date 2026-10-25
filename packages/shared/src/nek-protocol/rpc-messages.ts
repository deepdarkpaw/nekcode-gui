/**
 * nek `AgentMessage` 与内容块的 JSON 镜像。
 *
 * 事实来源：nek `packages/ai/src/types.ts`、`packages/agent/src/types.ts`、
 * `packages/coding-agent/src/core/messages.ts`，文档 `docs/message-types.md`。
 * 本文件只描述线上 JSON 形状，不 import nek 的任何包；字段与 nek 同名同义，
 * 未知字段一律允许（nek 会在不破坏兼容的前提下添加字段）。
 */

// ============================================================================
// 内容块
// ============================================================================

/** 文本块。`textSignature` 是 provider 私有回放数据，对 GUI 不透明。 */
export interface NekTextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

/** 图片块。`data` 是 base64。 */
export interface NekImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** 思考块。`redacted` 时可能没有可读文本，只有 `thinkingSignature` 里的加密载荷。 */
export interface NekThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

/** 模型发起的工具调用。 */
export interface NekToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
  /** OpenAI Responses 动态命名空间工具的命名空间。 */
  namespace?: string;
}

/** 工具声明（system message 的 `toolsAdded`）。参数 schema 是 JSON Schema。 */
export interface NekToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  constrainedSampling?: unknown;
}

/** 工具引用（system message 的 `toolsRemoved`）。 */
export interface NekToolReference {
  name: string;
}

// ============================================================================
// Usage
// ============================================================================

export interface NekUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** `reasoning` 已包含在 `output` 里，不要重复计。`cacheWrite1h` 是 `cacheWrite` 的子集。 */
export interface NekUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: NekUsageCost;
}

// ============================================================================
// 消息
// ============================================================================

/**
 * system 消息既承载首轮 prompt，也承载后续的补丁：`sections` 按名字替换（`null` 删除），
 * `toolsAdded`/`toolsRemoved` 增删工具，`replace: true` 丢弃之前的状态重新建立基线。
 */
export interface NekSystemMessage {
  role: "system";
  content: string | NekTextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: NekToolDefinition[];
  toolsRemoved?: NekToolReference[];
  replace?: boolean;
  timestamp: number;
}

export interface NekUserMessage {
  role: "user";
  content: string | Array<NekTextContent | NekImageContent>;
  timestamp: number;
}

/** provider 侧的延迟响应句柄（`stopReason: "deferred"`）。 */
export interface NekDeferredHandle {
  provider: string;
  modelId: string;
  api: string;
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  data?: unknown;
}

export type NekStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

export interface NekAssistantMessage {
  role: "assistant";
  content: Array<NekTextContent | NekThinkingContent | NekToolCall>;
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  diagnostics?: unknown[];
  usage: NekUsage;
  stopReason: NekStopReason;
  deferred?: NekDeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}

export interface NekToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<NekTextContent | NekImageContent>;
  /** 工具私有载荷（GUI 的卡片用它渲染；nek 保证可 JSON 序列化）。 */
  details?: unknown;
  /** 工具内部嵌套模型调用的用量。 */
  usage?: NekUsage;
  isError: boolean;
  timestamp: number;
}

/** 直接的 shell 命令执行结果（不是 LLM 工具结果）。 */
export interface NekBashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}

/** 扩展注入的上下文消息。`details` 不发给模型。 */
export interface NekCustomMessage {
  role: "custom";
  customType: string;
  content: string | Array<NekTextContent | NekImageContent>;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface NekBranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

export interface NekCompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/**
 * 宿主可以用 TypeScript declaration merging 给 `AgentMessage` 加角色，
 * 因此消费端必须容忍未知 role（`NekUnknownMessage`）。
 */
export interface NekUnknownMessage {
  role: string;
  timestamp?: number;
  [key: string]: unknown;
}

export type NekAgentMessage =
  | NekSystemMessage
  | NekUserMessage
  | NekAssistantMessage
  | NekToolResultMessage
  | NekBashExecutionMessage
  | NekCustomMessage
  | NekBranchSummaryMessage
  | NekCompactionSummaryMessage
  | NekUnknownMessage;

// ============================================================================
// 会话条目（`get_entries` / `read_session_snapshot`）
// ============================================================================

export const NEK_SESSION_VERSION = 3;

/** 会话头。JSONL 时代的第一行；RPC 模式不输出，用 `get_state` 取。 */
export interface NekSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface NekSessionEntryBase {
  type: string;
  /** 通常是 8 位 hex，也可能退化成完整 UUID。 */
  id: string;
  parentId: string | null;
  /** ISO 8601。注意消息内部的 `timestamp` 是 Unix 毫秒。 */
  timestamp: string;
}

export interface NekSessionMessageEntry extends NekSessionEntryBase {
  type: "message";
  message: NekAgentMessage;
}

export interface NekThinkingLevelChangeEntry extends NekSessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface NekModelChangeEntry extends NekSessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface NekUsageEntry extends NekSessionEntryBase {
  type: "usage";
  /** 任意用量分类，例如 `cache_warm`；未知值当普通用量处理。 */
  kind: string;
  provider: string;
  model: string;
  usage: NekUsage;
  note?: string;
}

export interface NekCompactionEntry {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  usage?: NekUsage;
  fromHook?: boolean;
  /** 压缩边界处完整的 prompt 与工具状态。 */
  systemMessage?: NekSystemMessage;
}

export interface NekBranchSummaryEntry {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;
  fromId: string;
  summary: string;
  details?: unknown;
  usage?: NekUsage;
  fromHook?: boolean;
}

export interface NekCustomEntry {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data?: unknown;
}

export interface NekLabelEntry {
  type: "label";
  id: string;
  parentId: string | null;
  timestamp: string;
  targetId: string;
  label?: string;
}

export interface NekSessionInfoEntry {
  type: "session_info";
  id: string;
  parentId: string | null;
  timestamp: string;
  name?: string;
}

export interface NekCustomMessageEntry {
  type: "custom_message";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  content: string | Array<NekTextContent | NekImageContent>;
  details?: unknown;
  display: boolean;
}

/** 追加式上下文编辑：只改未来模型上下文，不改历史与 UI。 */
export interface NekContextEditEntry {
  type: "context_edit";
  id: string;
  parentId: string | null;
  timestamp: string;
  targetId: string;
  replacement: { content: unknown } | null;
}

export type NekSessionEntry =
  | NekSessionMessageEntry
  | NekThinkingLevelChangeEntry
  | NekModelChangeEntry
  | NekUsageEntry
  | NekCompactionEntry
  | NekBranchSummaryEntry
  | NekCustomEntry
  | NekLabelEntry
  | NekSessionInfoEntry
  | NekCustomMessageEntry
  | NekContextEditEntry;

/** `get_tree` 的节点。 */
export interface NekSessionTreeNode {
  entry: NekSessionEntry;
  children: NekSessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}
