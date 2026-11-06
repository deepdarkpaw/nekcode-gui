/**
 * nek 会话事件、扩展 UI 子协议与 GUI 扩展事件的 JSON 镜像。
 *
 * 事实来源：`packages/coding-agent/src/core/agent-session.ts`（`AgentSessionEvent`）、
 * `modes/rpc/rpc-types.ts`（`RpcExtensionUIRequest`/`Response`）、`modes/json-event.ts`
 * （`JsonAgentSessionEvent`：`message_update` 去掉累积快照，只留增量）与
 * `docs/json.md`、`docs/rpc-extension-ui.md`。GUI 侧新增的 `extension_event` / `auth_event` /
 * `extension_ui_cancel` / `structured` 见 `gui-rpc.ts`。
 */
import type {
  NekAssistantMessage,
  NekImageContent,
  NekSessionEntry,
  NekToolCall,
  NekUsage,
} from "./rpc-messages.js";
import type { NekAuthEventRecord, NekExtensionEvent, NekStructuredUiRequest } from "./gui-rpc.js";

// ============================================================================
// 流式增量（`message_update.assistantMessageEvent`）
// ============================================================================

/**
 * 普通增量去掉 `partial` 与顶层累积 `message`；start 的显式替换快照保留 message。
 * toolcall_delta 区分 raw JSON、arguments 替换、argumentPath 字段追加，不能混为字符串拼接。
 */
export type NekAssistantMessageEvent =
  | { type: "start"; message?: NekAssistantMessage }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      /** Durable 参数块替换；此时 delta 不是可追加的 JSON 片段。 */
      arguments?: NekToolCall["arguments"];
      /** Durable 参数字段追加；路径相对 arguments 根。 */
      argumentPath?: readonly (string | number)[];
    }
  | { type: "toolcall_end"; contentIndex: number; toolCall: NekToolCall }
  | {
      type: "done";
      reason: "stop" | "length" | "toolUse" | "deferred";
      message?: NekAssistantMessage;
    }
  | { type: "error"; reason: "aborted" | "error"; error?: NekAssistantMessage };

// ============================================================================
// 会话事件（stdout）
// ============================================================================

/** `entry_appended` 携带的持久条目。 */
export type NekEntryAppendedEvent = { type: "entry_appended"; entry: NekSessionEntry };

/** 工具执行三件套；`partialResult` 是该工具的最新部分结果（替换或追加由工具自己的契约决定）。 */
export type NekToolExecutionEvent =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

/** nek 会话事件（JSON 模式下与 RPC 模式同形）的联合。 */
export type NekAgentSessionEvent =
  // 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[]; willRetry: boolean }
  | { type: "agent_settled"; outcome?: unknown }
  | { type: "turn_start" }
  | { type: "turn_end"; message: unknown; toolResults: unknown[] }
  // 消息
  | { type: "message_start"; message: unknown }
  | { type: "message_update"; usage: NekUsage; assistantMessageEvent: NekAssistantMessageEvent }
  | { type: "message_end"; message: unknown }
  // 工具
  | NekToolExecutionEvent
  // 队列与状态
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | NekEntryAppendedEvent
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: string }
  // 压缩
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result?: unknown;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  // 重试
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "summarization_retry_scheduled";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "summarization_retry_attempt_start";
      source: "branchSummary" | "compaction";
      reason?: string;
    }
  | { type: "summarization_retry_finished" }
  // 仅 RPC 模式
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string };

export type NekAgentSessionEventType = NekAgentSessionEvent["type"];

// ============================================================================
// 扩展 UI（双向）
// ============================================================================

/** 需要用户回答的 dialog 类请求；nek 侧可能在 `timeout` 后自动收口。 */
export type NekExtensionUiDialogRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string };

/**
 * fire-and-forget 类请求：不需要回答，但同一次调用在 TUI 里会改变界面状态，
 * GUI 需要自己维护 status/widget/title/editor 的当前值。
 */
export type NekExtensionUiFireAndForgetRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** 全部扩展 UI 请求：dialog + fire-and-forget + GUI 新增的 structured。 */
export type NekExtensionUiRequest =
  | NekExtensionUiDialogRequest
  | NekExtensionUiFireAndForgetRequest
  | NekStructuredUiRequest;

/** dialog 类请求的回答。 */
export type NekExtensionUiDialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

/** 回给 nek 的扩展 UI 响应（dialog 与 structured 都在这里）。 */
export type NekExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; result: unknown }
  | { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// GUI 交互桥（host → renderer）
// ============================================================================

/**
 * 交互请求属于哪个工作区、哪个会话。
 *
 * 创建会话之前的项目信任确认没有会话：此时只有 `workspacePath`，GUI 用工作区级
 * 确认框渲染，不允许把它塞进某个会话的交互队列。
 */
export interface NekInteractionScope {
  workspacePath: string;
  sessionKey?: string;
  sessionId?: string;
}

/** 需要 GUI 回答的交互请求（dialog / structured）或只需展示的通知（fire-and-forget）。 */
export interface NekInteractionRequestEvent {
  scope: NekInteractionScope;
  request: NekExtensionUiRequest;
}

/** nek 侧（或 host 超时）撤销了某个交互请求，GUI 关闭对应卡片。 */
export interface NekInteractionCancelEvent {
  scope: NekInteractionScope;
  id: string;
}

/** 交互通道的一帧：新请求，或撤销某个还在等的请求。 */
export type NekInteractionFrame =
  | ({ kind: "request" } & NekInteractionRequestEvent)
  | ({ kind: "cancel" } & NekInteractionCancelEvent);

// ============================================================================
// 事件联合
// ============================================================================

/** stdout 上除了 `response` 之外的所有记录。 */
export type NekRpcEvent =
  | NekAgentSessionEvent
  | NekExtensionUiRequest
  | NekExtensionEvent
  | NekAuthEventRecord
  | { type: "extension_ui_cancel"; id: string };

export type NekRpcEventType = NekRpcEvent["type"];

/** 按 `type` 取事件载荷。 */
export type NekRpcEventOfType<T extends NekRpcEventType> = Extract<NekRpcEvent, { type: T }>;

/** 输入附件（`prompt`/`steer`/`follow_up` 的 images）。 */
export type NekPromptImage = NekImageContent;
