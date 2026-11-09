import type { NekStatusDirectEvent, NekSessionStatus, RetryKind, RetryState } from "./types.js";
import { makeNotice, pushNotice, updateTimestamp } from "./reducerUtils.js";

function retryStart(
  kind: RetryKind,
  attempt: number,
  max: number,
  delayMs: number,
  errorMessage: string,
  now: number,
): RetryState {
  return { phase: "waiting", kind, attempt, max, delayMs, startedAt: now, errorMessage };
}

export function reduceRetryEvent(
  state: NekSessionStatus,
  event: NekStatusDirectEvent,
  now: number,
): NekSessionStatus {
  switch (event.type) {
    case "auto_retry_start":
      return updateTimestamp(
        {
          ...state,
          retry: retryStart(
            "agent",
            event.attempt,
            event.maxAttempts,
            event.delayMs,
            event.errorMessage,
            now,
          ),
        },
        now,
      );
    case "summarization_retry_scheduled":
      return updateTimestamp(
        {
          ...state,
          retry: retryStart(
            "summarization",
            event.attempt,
            event.maxAttempts,
            event.delayMs,
            event.errorMessage,
            now,
          ),
        },
        now,
      );
    case "summarization_retry_attempt_start": {
      const retry = state.retry;
      if (!retry || retry.phase === "failed") return state;
      return updateTimestamp(
        {
          ...state,
          retry: {
            phase: "retrying",
            kind: retry.kind,
            attempt: retry.attempt,
            max: retry.max,
            errorMessage: retry.phase === "waiting" ? retry.errorMessage : "",
          },
        },
        now,
      );
    }
    case "auto_retry_end":
      if (event.success) return updateTimestamp({ ...state, retry: null }, now);
      return updateTimestamp(
        {
          ...state,
          retry: {
            phase: "failed",
            kind: state.retry?.kind ?? "agent",
            max: state.retry?.max ?? event.attempt,
            finalError:
              event.finalError ??
              (state.retry?.phase === "waiting" ? state.retry.errorMessage : ""),
          },
        },
        now,
      );
    case "summarization_retry_finished":
      return updateTimestamp({ ...state, retry: null }, now);
    default:
      return state;
  }
}

export function advanceNekStatus(state: NekSessionStatus, now = Date.now()): NekSessionStatus {
  const retry = state.retry;
  if (!retry || retry.phase !== "waiting" || now - retry.startedAt < retry.delayMs) {
    return state;
  }
  return updateTimestamp(
    {
      ...state,
      retry: {
        phase: "retrying",
        kind: retry.kind,
        attempt: retry.attempt,
        max: retry.max,
        errorMessage: retry.errorMessage,
      },
    },
    now,
  );
}

export function markRetryCancelling(state: NekSessionStatus): NekSessionStatus {
  if (!state.retry || (state.retry.phase !== "waiting" && state.retry.phase !== "retrying")) {
    return state;
  }
  return {
    ...state,
    retry: {
      phase: "cancelling",
      kind: state.retry.kind,
      attempt: state.retry.attempt,
      max: state.retry.max,
    },
  };
}

export function reduceCompactionEvent(
  state: NekSessionStatus,
  event: NekStatusDirectEvent,
  sessionKey: string,
  now: number,
): { state: NekSessionStatus; noticeId?: string } {
  switch (event.type) {
    case "compaction_start":
      return {
        state: updateTimestamp(
          {
            ...state,
            compaction: { phase: "running", reason: event.reason, startedAt: now },
          },
          now,
        ),
      };
    case "compaction_end": {
      if (event.aborted) {
        const notice = makeNotice(sessionKey, "nek.status.compaction.aborted", now);
        return {
          state: pushNotice(updateTimestamp({ ...state, compaction: null }, now), notice),
          noticeId: notice.id,
        };
      }
      if (event.errorMessage) {
        return {
          state: updateTimestamp(
            { ...state, compaction: { phase: "failed", message: event.errorMessage } },
            now,
          ),
        };
      }
      /** willRetry belongs to the resumed model request, not to the completed compaction. */
      return {
        state: updateTimestamp({ ...state, compaction: null, statsStale: true }, now),
      };
    }
    default:
      return { state };
  }
}
