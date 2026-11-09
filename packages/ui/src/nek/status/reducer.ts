import type { NekRpcEvent, NekState, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import {
  NEK_STATUS_MAX_PLANS,
  NEK_STATUS_MAX_QUEUE_ITEMS,
  NEK_STATUS_MAX_TODOS,
  type NekSessionStatus,
  type NekStatusDirectEvent,
  type NekStatusEvent,
  type NekStatusEventOutput,
} from "./types.js";
import { abortRunningSubagents, mergeStateSubagents, upsertSubagent } from "./subagentReducer.js";
import {
  advanceNekStatus,
  reduceCompactionEvent,
  reduceRetryEvent,
} from "./retryCompactionReducer.js";
import { makeNotice, markStatsStale, updateTimestamp } from "./statusStateUtils.js";

const EMPTY_OUTPUT: NekStatusEventOutput = { needsStatsRefresh: false };

export function createNekSessionStatus(now = Date.now()): NekSessionStatus {
  return {
    running: false,
    mode: "agent",
    todos: [],
    plans: [],
    subagents: { order: [], byId: {} },
    queue: { steering: [], followUp: [] },
    retry: null,
    compaction: null,
    statsStale: false,
    statsRefreshPending: false,
    finishedSubagentIds: [],
    notices: [],
    lastUpdatedAt: now,
  };
}

function isNekState(value: unknown): value is NekState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NekState>;
  return (
    (candidate.mode === "agent" || candidate.mode === "plan") &&
    Array.isArray(candidate.todos) &&
    Array.isArray(candidate.plans) &&
    Array.isArray(candidate.subagents)
  );
}

function normalizeEvent(event: NekStatusEvent): NekStatusDirectEvent | null {
  if (
    event.type === "nek.state" ||
    event.type === "nek.subagent" ||
    event.type === "session_stats" ||
    event.type === "session_snapshot" ||
    event.type === "session_opened" ||
    event.type === "process_exit"
  ) {
    return event;
  }
  if (event.type === "extension_event") {
    if (event.name === "nek.state" && isNekState(event.payload)) {
      return { type: "nek.state", payload: event.payload };
    }
    if (
      event.name === "nek.subagent" &&
      typeof event.payload === "object" &&
      event.payload !== null &&
      typeof (event.payload as { id?: unknown }).id === "string"
    ) {
      return {
        type: "nek.subagent",
        payload: event.payload as NekSubagentRecord,
      };
    }
    return null;
  }
  return isStatusDirectEvent(event) ? event : null;
}

function isStatusDirectEvent(
  event: NekRpcEvent | NekStatusDirectEvent,
): event is NekStatusDirectEvent {
  return (
    event.type === "queue_update" ||
    event.type === "agent_start" ||
    event.type === "agent_settled" ||
    event.type === "message_start" ||
    event.type === "message_end" ||
    event.type === "compaction_start" ||
    event.type === "compaction_end" ||
    event.type === "auto_retry_start" ||
    event.type === "auto_retry_end" ||
    event.type === "summarization_retry_scheduled" ||
    event.type === "summarization_retry_attempt_start" ||
    event.type === "summarization_retry_finished"
  );
}

function withStatsRefresh(
  state: NekSessionStatus,
  now: number,
): { state: NekSessionStatus; output: NekStatusEventOutput } {
  const result = markStatsStale(state, now);
  return { state: result.state, output: { needsStatsRefresh: result.needsStatsRefresh } };
}

export function reduceNekStatusEvent(
  state: NekSessionStatus,
  sessionKey: string,
  input: NekStatusEvent,
  now = Date.now(),
): { state: NekSessionStatus; output: NekStatusEventOutput } {
  const event = normalizeEvent(input);
  if (!event) return { state, output: EMPTY_OUTPUT };
  switch (event.type) {
    case "nek.state": {
      const merged = mergeStateSubagents(state, sessionKey, event.payload.subagents, now);
      return {
        state: updateTimestamp(
          {
            ...merged.state,
            mode: event.payload.mode,
            todos: event.payload.todos.slice(0, NEK_STATUS_MAX_TODOS),
            plans: event.payload.plans.slice(-NEK_STATUS_MAX_PLANS),
            activePlanPath: event.payload.activePlanPath,
          },
          now,
        ),
        output: {
          needsStatsRefresh: false,
          ...(merged.events.length > 0 ? { subagentFinished: merged.events } : {}),
        },
      };
    }
    case "nek.subagent": {
      const merged = upsertSubagent(state, sessionKey, event.payload, now);
      return {
        state: merged.state,
        output: {
          needsStatsRefresh: false,
          ...(merged.event ? { subagentFinished: [merged.event] } : {}),
        },
      };
    }
    case "session_stats":
      return {
        state: updateTimestamp(
          {
            ...state,
            stats: event.payload,
            statsStale: false,
            statsRefreshPending: false,
          },
          now,
        ),
        output: EMPTY_OUTPUT,
      };
    case "session_snapshot": {
      // 快照是权威事实，但仍要遵守 ST-1/ST-2：子代理走 mergeStateSubagents（终态不回退）。
      // 压缩原因与排队正文只在事件里有，所以快照只用来"收掉"已经结束的压缩横幅与空队列。
      const merged = mergeStateSubagents(state, sessionKey, event.payload.state.subagents, now);
      return {
        state: updateTimestamp(
          {
            ...merged.state,
            running: event.payload.running,
            mode: event.payload.state.mode,
            todos: event.payload.state.todos.slice(0, NEK_STATUS_MAX_TODOS),
            plans: event.payload.state.plans.slice(-NEK_STATUS_MAX_PLANS),
            activePlanPath: event.payload.state.activePlanPath,
            compaction: event.payload.compacting ? merged.state.compaction : null,
            queue:
              event.payload.pendingMessageCount === 0
                ? { steering: [], followUp: [] }
                : merged.state.queue,
            stats: event.payload.stats,
            statsStale: false,
            statsRefreshPending: false,
          },
          now,
        ),
        output: {
          needsStatsRefresh: false,
          ...(merged.events.length > 0 ? { subagentFinished: merged.events } : {}),
        },
      };
    }
    case "session_opened":
      return withStatsRefresh(state, now);
    case "agent_start":
      return { state: updateTimestamp({ ...state, running: true }, now), output: EMPTY_OUTPUT };
    case "agent_settled":
      return withStatsRefresh(updateTimestamp({ ...state, running: false }, now), now);
    case "message_end":
      return withStatsRefresh(state, now);
    case "message_start":
      return { state, output: EMPTY_OUTPUT };
    case "queue_update":
      return {
        state: updateTimestamp(
          {
            ...state,
            queue: {
              steering: event.steering.slice(0, NEK_STATUS_MAX_QUEUE_ITEMS),
              followUp: event.followUp.slice(0, NEK_STATUS_MAX_QUEUE_ITEMS),
            },
          },
          now,
        ),
        output: EMPTY_OUTPUT,
      };
    case "process_exit": {
      const aborted = abortRunningSubagents(state, sessionKey, now);
      return {
        state: updateTimestamp(
          {
            ...aborted.state,
            running: false,
            retry: null,
            compaction: null,
            queue: { steering: [], followUp: [] },
          },
          now,
        ),
        output: {
          needsStatsRefresh: false,
          ...(aborted.events.length > 0 ? { subagentFinished: aborted.events } : {}),
        },
      };
    }
    case "compaction_start":
    case "compaction_end": {
      const result = reduceCompactionEvent(state, event, sessionKey, now);
      if (event.type === "compaction_end") {
        const refreshed = withStatsRefresh(result.state, now);
        return {
          state: refreshed.state,
          output: {
            ...refreshed.output,
            ...(result.noticeId ? { notice: makeNotice(sessionKey, result.noticeId, now) } : {}),
          },
        };
      }
      return {
        state: result.state,
        output: {
          needsStatsRefresh: false,
          ...(result.noticeId ? { notice: makeNotice(sessionKey, result.noticeId, now) } : {}),
        },
      };
    }
    case "auto_retry_start":
    case "auto_retry_end":
    case "summarization_retry_scheduled":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return {
        state: reduceRetryEvent(state, event, now),
        output: EMPTY_OUTPUT,
      };
  }
}

export { advanceNekStatus };

export function markStopRequested(
  state: NekSessionStatus,
  id: string,
  now = Date.now(),
): NekSessionStatus {
  const current = state.subagents.byId[id];
  if (!current || current.status !== "running" || current.stopRequested) return state;
  return {
    ...state,
    subagents: {
      ...state.subagents,
      byId: {
        ...state.subagents.byId,
        [id]: { ...current, stopRequested: true, stopRequestedAt: now },
      },
    },
    lastUpdatedAt: now,
  };
}

export function clearStopRequested(state: NekSessionStatus, id: string): NekSessionStatus {
  const current = state.subagents.byId[id];
  if (!current?.stopRequested) return state;
  const { stopRequested: _stopRequested, stopRequestedAt: _stopRequestedAt, ...record } = current;
  return {
    ...state,
    subagents: { ...state.subagents, byId: { ...state.subagents.byId, [id]: record } },
  };
}
