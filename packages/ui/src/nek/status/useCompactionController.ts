import { useMemo } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useNowTicker } from "@/hooks/useNowTicker.js";
import { useNekStatusStore } from "./store.js";
import {
  ACTION_BUSY,
  type StatusActionHandle,
  type StatusKeyDown,
  type StatusMessage,
} from "./controllerTypes.js";
import { formatDuration } from "./format.js";

export interface CompactionControllerProps {
  sessionKey: string;
  abortCompaction: () => Promise<void>;
}

const REASON_MESSAGES: Record<"manual" | "threshold" | "overflow", StatusMessage> = {
  manual: { id: "nek.status.compaction.manual" },
  threshold: { id: "nek.status.compaction.threshold" },
  overflow: { id: "nek.status.compaction.overflow" },
};

export interface CompactionController {
  view: {
    visible: boolean;
    phase?: "running" | "failed";
    reason?: "manual" | "threshold" | "overflow";
    message?: StatusMessage;
    elapsedMs?: number;
    elapsed?: string;
    error?: string;
    notice?: StatusMessage;
  };
  actions: { cancelCompaction: StatusActionHandle; dismiss: StatusActionHandle };
  onKeyDown: StatusKeyDown;
}

export function useCompactionController({
  sessionKey,
  abortCompaction,
}: CompactionControllerProps): CompactionController {
  const status = useNekStatusStore((state) => state.sessions[sessionKey]);
  const compaction = status?.compaction ?? null;
  const now = useNowTicker(compaction?.phase === "running");
  const cancelAction = useAsyncAction(abortCompaction, { successFeedbackMs: 0 });
  const dismissAction = useAsyncAction(
    async () => {
      useNekStatusStore.setState((state) => {
        const current = state.sessions[sessionKey];
        if (!current || current.compaction?.phase !== "failed") return state;
        return {
          sessions: { ...state.sessions, [sessionKey]: { ...current, compaction: null } },
        };
      });
    },
    { successFeedbackMs: 0 },
  );
  const cancelPending = cancelAction.state.status === "pending";
  const dismissPending = dismissAction.state.status === "pending";

  const cancelCompaction: StatusActionHandle = useMemo(
    () => ({
      visible: compaction?.phase === "running",
      enabled: compaction?.phase === "running" && !cancelPending,
      ...(compaction?.phase === "running" && cancelPending ? { disabledReason: ACTION_BUSY } : {}),
      pending: cancelPending,
      error: cancelAction.state.status === "error" ? cancelAction.state.message : undefined,
      run: async () => {
        if (compaction?.phase === "running" && !cancelPending) await cancelAction.run();
      },
    }),
    [cancelAction, cancelPending, compaction],
  );
  const dismiss: StatusActionHandle = useMemo(
    () => ({
      visible: compaction?.phase === "failed",
      enabled: compaction?.phase === "failed" && !dismissPending,
      ...(compaction?.phase === "failed" && dismissPending ? { disabledReason: ACTION_BUSY } : {}),
      pending: dismissPending,
      error: dismissAction.state.status === "error" ? dismissAction.state.message : undefined,
      run: async () => {
        if (compaction?.phase === "failed" && !dismissPending) await dismissAction.run();
      },
    }),
    [compaction, dismissAction, dismissPending],
  );

  if (!compaction) {
    return {
      view: { visible: false },
      actions: { cancelCompaction, dismiss },
      onKeyDown: () => undefined,
    };
  }
  if (compaction.phase === "failed") {
    return {
      view: { visible: true, phase: "failed", error: compaction.message },
      actions: { cancelCompaction, dismiss },
      onKeyDown: () => undefined,
    };
  }
  const elapsedMs = Math.max(0, now - compaction.startedAt);
  return {
    view: {
      visible: true,
      phase: "running",
      reason: compaction.reason,
      message: REASON_MESSAGES[compaction.reason],
      elapsedMs,
      elapsed: formatDuration(elapsedMs),
      ...(status?.notices.at(-1)?.id === "nek.status.compaction.aborted"
        ? { notice: { id: "nek.status.compaction.aborted" } }
        : {}),
    },
    actions: { cancelCompaction, dismiss },
    onKeyDown: () => undefined,
  };
}
