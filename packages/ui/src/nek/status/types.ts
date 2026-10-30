import {
  NEK_STATUS_FRAME_MAX_PLANS,
  NEK_STATUS_FRAME_MAX_QUEUE_ITEMS,
  NEK_STATUS_FRAME_MAX_SUBAGENTS,
  NEK_STATUS_FRAME_MAX_TODOS,
  type NekAgentSessionEvent,
  type NekMode,
  type NekPlanSummary,
  type NekRpcEvent,
  type NekSessionStats,
  type NekState,
  type NekStatusSnapshot,
  type NekSubagentRecord,
  type NekTodo,
} from "@zcode/shared/nek-protocol";

export const NEK_STATUS_MAX_SESSIONS = 20;
export const NEK_STATUS_MAX_TODOS = NEK_STATUS_FRAME_MAX_TODOS;
export const NEK_STATUS_MAX_PLANS = NEK_STATUS_FRAME_MAX_PLANS;
export const NEK_STATUS_MAX_QUEUE_ITEMS = NEK_STATUS_FRAME_MAX_QUEUE_ITEMS;
export const NEK_STATUS_MAX_SUBAGENTS = NEK_STATUS_FRAME_MAX_SUBAGENTS;
export const NEK_STATUS_MAX_FINISHED_IDS = 200;
export const NEK_STATUS_MAX_NOTICES = 50;
export const NEK_STATUS_STATS_THROTTLE_MS = 1_000;
export const NEK_STATUS_STOP_TIMEOUT_MS = 15_000;
export const NEK_STATUS_TRANSCRIPT_MAX_MESSAGES = 500;
export const NEK_STATUS_TODO_CHANGE_MS = 1_500;
export const NEK_STATUS_TRANSCRIPT_REFRESH_MS = 3_000;

export type NekStatusSubagent = NekSubagentRecord & {
  stopRequested?: boolean;
  stopRequestedAt?: number;
};

export type RetryKind = "agent" | "summarization";

export type RetryState =
  | {
      phase: "waiting";
      kind: RetryKind;
      attempt: number;
      max: number;
      delayMs: number;
      startedAt: number;
      errorMessage: string;
    }
  | {
      phase: "retrying";
      kind: RetryKind;
      attempt: number;
      max: number;
      errorMessage: string;
    }
  | { phase: "cancelling"; kind: RetryKind; attempt: number; max: number }
  | { phase: "failed"; kind: RetryKind; max: number; finalError: string };

export interface CompactionRunningState {
  phase: "running";
  reason: "manual" | "threshold" | "overflow";
  startedAt: number;
}

export interface CompactionFailedState {
  phase: "failed";
  message: string;
}

export type CompactionState = CompactionRunningState | CompactionFailedState;

export interface NekStatusQueue {
  steering: string[];
  followUp: string[];
}

export interface NekStatusSubagents {
  order: string[];
  byId: Record<string, NekStatusSubagent>;
}

export interface NekSessionStatus {
  running: boolean;
  mode: NekMode;
  todos: NekTodo[];
  plans: NekPlanSummary[];
  activePlanPath?: string;
  subagents: NekStatusSubagents;
  queue: NekStatusQueue;
  retry: RetryState | null;
  compaction: CompactionState | null;
  stats?: NekSessionStats;
  statsStale: boolean;
  statsRefreshPending: boolean;
  lastStatsRefreshAt?: number;
  finishedSubagentIds: string[];
  notices: NekStatusNotice[];
  lastUpdatedAt: number;
}

export interface NekStatusNotice {
  id: string;
  values?: Record<string, string | number>;
  sessionKey: string;
  createdAt: number;
}

export interface SubagentFinishedEvent {
  type: "subagentFinished";
  sessionKey: string;
  id: string;
  status: "completed" | "errored" | "aborted";
  description: string;
  background: boolean;
}

export interface NekStatusEventOutput {
  subagentFinished?: SubagentFinishedEvent[];
  notice?: NekStatusNotice;
  needsStatsRefresh: boolean;
}

export type NekStatusDirectEvent =
  | { type: "nek.state"; payload: NekState }
  | { type: "nek.subagent"; payload: NekSubagentRecord }
  | { type: "session_stats"; payload: NekSessionStats }
  /** 服务层补齐的权威快照（打开/恢复会话、renderer 迟订阅）。 */
  | { type: "session_snapshot"; payload: NekStatusSnapshot }
  | { type: "session_opened" }
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
  /** 消息边界只用于把用量置为过期（ST-7）；服务层已经把消息载荷丢掉。 */
  | { type: "message_start" }
  | { type: "message_end" }
  | { type: "process_exit" };

export type NekStatusEvent = NekRpcEvent | NekStatusDirectEvent;

export interface NekStatusSessionEntry {
  sessionKey: string;
  status: NekSessionStatus;
}

export interface NekStatusStoreState {
  sessions: Record<string, NekSessionStatus>;
  consumeEvent: (sessionKey: string, event: NekStatusEvent, now?: number) => NekStatusEventOutput;
  setStats: (sessionKey: string, stats: NekSessionStats, now?: number) => void;
  markStatsFresh: (sessionKey: string, now?: number) => void;
  flushStatsRefresh: (sessionKey: string, now?: number) => boolean;
  tick: (sessionKey: string, now?: number) => void;
  markStopRequested: (sessionKey: string, id: string, now?: number) => void;
  clearStopRequested: (sessionKey: string, id: string) => void;
  clearRetry: (sessionKey: string) => void;
  removeSession: (sessionKey: string) => void;
  reset: () => void;
}
