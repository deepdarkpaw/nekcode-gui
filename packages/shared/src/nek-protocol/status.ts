/**
 * nek 会话状态 feed 的跨进程帧。
 *
 * 帧不是对话日志：它只携带 status store 所需的权威状态，且所有可变数组
 * 在服务侧投影前先裁剪，避免迟到 renderer 或异常扩展造成无界内存/IPC 载荷。
 */
import type { NekAgentSessionEvent, NekRpcEvent } from "./rpc-events.js";
import type { NekSessionStats } from "./rpc.js";
import type {
  NekMode,
  NekPlanSummary,
  NekState,
  NekSubagentRecord,
  NekTodo,
} from "./gui-extension-api.js";

export const NEK_STATUS_FRAME_MAX_TODOS = 100;
export const NEK_STATUS_FRAME_MAX_PLANS = 50;
export const NEK_STATUS_FRAME_MAX_QUEUE_ITEMS = 100;
export const NEK_STATUS_FRAME_MAX_SUBAGENTS = 50;
export const NEK_STATUS_FRAME_MAX_TEXT = 8_192;

export interface NekStatusQueue {
  steering: string[];
  followUp: string[];
}

export interface NekStatusSnapshot {
  sessionKey: string;
  running: boolean;
  state: NekState;
  stats: NekSessionStats;
}

/** 只把会话事件中 status store 能消费的部分发给 renderer。 */
export type NekStatusFrameEvent =
  | Extract<
      NekAgentSessionEvent,
      {
        type:
          | "agent_start"
          | "agent_settled"
          | "message_start"
          | "message_end"
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
  | Extract<NekRpcEvent, { type: "extension_event" }>
  | { type: "session_stats"; payload: NekSessionStats }
  | { type: "session_opened" }
  | { type: "process_exit" };

export type NekStatusFrame =
  | { kind: "snapshot"; sessionKey: string; snapshot: NekStatusSnapshot }
  | { kind: "event"; sessionKey: string; event: NekStatusFrameEvent };

/** 仅用于保证跨模块引用时不会意外把镜像类型变成独立事实源。 */
export type NekStatusMode = NekMode;
export type NekStatusTodo = NekTodo;
export type NekStatusPlan = NekPlanSummary;
export type NekStatusSubagent = NekSubagentRecord;
