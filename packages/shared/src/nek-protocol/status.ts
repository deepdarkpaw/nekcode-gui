/**
 * nek 会话状态 feed 的跨进程帧。
 *
 * 帧不是对话日志：它只携带 status store 所需的权威状态。所有可变数组/文本在服务侧
 * 投影前先按下面的上限裁剪，迟到 renderer 或异常扩展都不会产生无界 IPC 载荷。
 * 上限与 renderer `nek/status/types.ts` 的 store 上限同源，二者不允许各自漂移。
 */
import type { NekExtensionEvent } from "./gui-rpc.js";
import type {
  NekMode,
  NekPlanSummary,
  NekState,
  NekSubagentRecord,
  NekTodo,
} from "./gui-extension-api.js";
import type { NekSessionStats } from "./rpc.js";
import type { NekAgentSessionEvent } from "./rpc-events.js";

export const NEK_STATUS_FRAME_MAX_TODOS = 100;
export const NEK_STATUS_FRAME_MAX_PLANS = 50;
export const NEK_STATUS_FRAME_MAX_QUEUE_ITEMS = 100;
export const NEK_STATUS_FRAME_MAX_SUBAGENTS = 50;
export const NEK_STATUS_FRAME_MAX_TEXT = 8_192;
/** 一次补齐最多快照多少个会话；与 renderer status store 的会话上限同值。 */
export const NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS = 20;

/** nek 一次 `clear_queue` 的返回值形状（取回与清空共用同一次 RPC）。 */
export interface NekStatusQueue {
  steering: string[];
  followUp: string[];
}

/**
 * 会话状态的权威快照：`state` 来自 `nek.get_state` 扩展，`stats` 来自 `get_session_stats`，
 * `running`/`compacting`/`pendingMessageCount` 来自会话级 `get_state`。
 *
 * `compacting` 与 `pendingMessageCount` 让迟订阅的 renderer 能收掉已经结束的压缩横幅和
 * 空队列，但快照里没有压缩原因与排队正文（nek 只在事件里报），因此这两项只能用于"清空"。
 * `sessionKey` 是 renderer 使用的会话标识。
 */
export interface NekStatusSnapshot {
  sessionKey: string;
  running: boolean;
  compacting: boolean;
  pendingMessageCount: number;
  state: NekState;
  stats: NekSessionStats;
}

/**
 * 只把 status store 能消费的会话事件发给 renderer。
 *
 * `agent_end`（低层 run 结束）不在其中：重试、压缩、steering 仍可能继续，
 * status 视图只看 `agent_settled`。`message_start`/`message_end` 只用于刷新用量，
 * 因此它们的消息载荷被整条丢弃，不进入 IPC。
 */
export type NekStatusFrameEvent =
  | Extract<
      NekAgentSessionEvent,
      {
        type:
          | "agent_start"
          | "agent_settled"
          | "queue_update"
          | "compaction_start"
          | "compaction_end"
          | "auto_retry_start"
          | "auto_retry_end"
          | "summarization_retry_scheduled"
          | "summarization_retry_attempt_start"
          | "summarization_retry_finished";
      }
    >
  | { type: "message_start" }
  | { type: "message_end" }
  | NekExtensionEvent
  | { type: "process_exit" };

/**
 * workspace 级状态帧：每帧都带会话标识，renderer 按 workspace 订阅一次即可覆盖该 workspace
 * 的全部会话。
 *
 * `snapshot` 用于打开/恢复会话与 renderer 迟订阅补齐；`closed` 表示会话已被关闭，
 * renderer 必须丢弃该会话的本地状态，不能继续显示上一次的行。
 */
export type NekStatusFrame =
  | { kind: "snapshot"; sessionKey: string; snapshot: NekStatusSnapshot }
  | { kind: "event"; sessionKey: string; event: NekStatusFrameEvent }
  | { kind: "closed"; sessionKey: string };

/** 仅用于保证跨模块引用时不会意外把镜像类型变成独立事实源。 */
export type NekStatusMode = NekMode;
export type NekStatusTodo = NekTodo;
export type NekStatusPlan = NekPlanSummary;
export type NekStatusSubagent = NekSubagentRecord;
