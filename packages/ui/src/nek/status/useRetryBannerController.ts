import { useEffect, useMemo } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useNowTicker } from "@/hooks/useNowTicker.js";
import { useNekStatusStore } from "./store.js";
import {
  ACTION_BUSY,
  type StatusActionHandle,
  type StatusKeyDown,
  type StatusMessage,
} from "./controllerTypes.js";
import { retryErrorSummary, retryRemainingSeconds } from "./format.js";
import type { RetryKind, RetryState } from "./types.js";

export interface RetryBannerControllerProps {
  sessionKey: string;
  abortRetry: () => Promise<void>;
  abort: () => Promise<void>;
}

export interface RetryBannerController {
  view: {
    visible: boolean;
    phase?: RetryState["phase"];
    kind?: RetryKind;
    message?: StatusMessage;
    errorSummary?: string;
    errorDetail?: string;
  };
  actions: { cancelRetry: StatusActionHandle; dismiss: StatusActionHandle };
  onKeyDown: StatusKeyDown;
}

function retryMessage(retry: RetryState, now: number): StatusMessage {
  if (retry.phase === "waiting") {
    return {
      id: "nek.status.retry.waiting",
      values: {
        attempt: retry.attempt,
        max: retry.max,
        seconds: retryRemainingSeconds(retry.delayMs, retry.startedAt, now),
      },
    };
  }
  if (retry.phase === "retrying") {
    return {
      id: "nek.status.retry.retrying",
      values: { attempt: retry.attempt, max: retry.max },
    };
  }
  if (retry.phase === "cancelling") return { id: "nek.status.retry.cancelling" };
  return { id: "nek.status.retry.failed", values: { max: retry.max } };
}

function errorText(retry: RetryState): string | undefined {
  if (retry.phase === "waiting" || retry.phase === "retrying") return retry.errorMessage;
  if (retry.phase === "failed") return retry.finalError;
  return undefined;
}

export function useRetryBannerController({
  sessionKey,
  abortRetry,
  abort,
}: RetryBannerControllerProps): RetryBannerController {
  const retry = useNekStatusStore((state) => state.sessions[sessionKey]?.retry ?? null);
  const tick = useNekStatusStore((state) => state.tick);
  const clearRetry = useNekStatusStore((state) => state.clearRetry);
  const now = useNowTicker(retry?.phase === "waiting" || retry?.phase === "retrying");

  useEffect(() => {
    if (!retry || retry.phase !== "waiting") return;
    tick(sessionKey, now);
  }, [now, retry, sessionKey, tick]);

  const cancelAction = useAsyncAction(
    async () => {
      if (!retry || (retry.phase !== "waiting" && retry.phase !== "retrying")) return;
      if (retry.kind === "agent") await abortRetry();
      else await abort();
      useNekStatusStore.setState((state) => {
        const current = state.sessions[sessionKey];
        const currentRetry = current?.retry;
        if (
          !current ||
          !currentRetry ||
          (currentRetry.phase !== "waiting" && currentRetry.phase !== "retrying")
        ) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionKey]: {
              ...current,
              retry: {
                phase: "cancelling",
                kind: currentRetry.kind,
                attempt: currentRetry.attempt,
                max: currentRetry.max,
              },
            },
          },
        };
      });
    },
    { successFeedbackMs: 0 },
  );
  const dismissAction = useAsyncAction(async () => clearRetry(sessionKey), {
    successFeedbackMs: 0,
  });
  const cancelPending = cancelAction.state.status === "pending";
  const dismissPending = dismissAction.state.status === "pending";

  const cancelRetry: StatusActionHandle = useMemo(
    () => ({
      visible: retry?.phase === "waiting" || retry?.phase === "retrying",
      enabled: (retry?.phase === "waiting" || retry?.phase === "retrying") && !cancelPending,
      ...((retry?.phase === "waiting" || retry?.phase === "retrying") && cancelPending
        ? { disabledReason: ACTION_BUSY }
        : {}),
      pending: cancelPending,
      error: cancelAction.state.status === "error" ? cancelAction.state.message : undefined,
      run: async () => {
        if (!cancelPending && (retry?.phase === "waiting" || retry?.phase === "retrying")) {
          await cancelAction.run();
        }
      },
    }),
    [cancelAction, cancelPending, retry],
  );
  const dismiss: StatusActionHandle = useMemo(
    () => ({
      visible: retry?.phase === "failed",
      enabled: retry?.phase === "failed" && !dismissPending,
      ...(retry?.phase === "failed" && dismissPending ? { disabledReason: ACTION_BUSY } : {}),
      pending: dismissPending,
      error: dismissAction.state.status === "error" ? dismissAction.state.message : undefined,
      run: async () => {
        if (!dismissPending && retry?.phase === "failed") await dismissAction.run();
      },
    }),
    [dismissAction, dismissPending, retry],
  );

  if (!retry) {
    return {
      view: { visible: false },
      actions: { cancelRetry, dismiss },
      onKeyDown: () => undefined,
    };
  }
  const error = errorText(retry);
  return {
    view: {
      visible: true,
      phase: retry.phase,
      kind: retry.kind,
      message: retryMessage(retry, now),
      ...(error !== undefined
        ? { errorSummary: retryErrorSummary(error), errorDetail: error }
        : {}),
    },
    actions: { cancelRetry, dismiss },
    onKeyDown: () => undefined,
  };
}
