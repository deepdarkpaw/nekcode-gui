import { useMemo } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useNekStatusStore } from "./store.js";
import {
  ACTION_BUSY,
  type StatusActionHandle,
  type StatusKeyDown,
  type StatusMessage,
} from "./controllerTypes.js";
import { contextLevel, formatTokens, formatUsage } from "./format.js";

export interface UsageIndicatorControllerProps {
  sessionKey: string;
  onCompact: () => Promise<void>;
}

export interface UsageIndicatorController {
  view:
    | { state: "empty" }
    | {
        state: "ready";
        tokens: ReturnType<typeof formatUsage>;
        context:
          | { percent: null; hintId: "nek.status.usage.afterCompaction" }
          | {
              percent: number;
              tokens: string;
              window: string;
              summary: StatusMessage;
            };
        level: "neutral" | "warning" | "danger";
        stale: boolean;
      };
  actions: { compact: StatusActionHandle };
  onKeyDown: StatusKeyDown;
}

export function useUsageIndicatorController({
  sessionKey,
  onCompact,
}: UsageIndicatorControllerProps): UsageIndicatorController {
  const status = useNekStatusStore((state) => state.sessions[sessionKey]);
  const stats = status?.stats;
  const compactAction = useAsyncAction(onCompact, { successFeedbackMs: 0 });
  const pending = compactAction.state.status === "pending";
  const compacting = status?.compaction?.phase === "running";
  const compact: StatusActionHandle = useMemo(
    () => ({
      visible: stats !== undefined,
      enabled: stats !== undefined && !compacting && !pending,
      ...(compacting
        ? { disabledReason: { id: "nek.status.usage.compacting" } }
        : pending
          ? { disabledReason: ACTION_BUSY }
          : {}),
      pending,
      error: compactAction.state.status === "error" ? compactAction.state.message : undefined,
      run: async () => {
        if (stats && !compacting && !pending) await compactAction.run();
      },
    }),
    [compactAction, compacting, pending, stats],
  );

  if (!stats) {
    return { view: { state: "empty" }, actions: { compact }, onKeyDown: () => undefined };
  }
  const usage = formatUsage(stats);
  const contextUsage = stats.contextUsage;
  const context =
    !contextUsage || contextUsage.percent === null
      ? { percent: null, hintId: "nek.status.usage.afterCompaction" as const }
      : {
          percent: Math.round(contextUsage.percent),
          tokens: formatTokens(contextUsage.tokens ?? 0),
          window: formatTokens(contextUsage.contextWindow),
          summary: {
            id: "nek.status.usage.context",
            values: {
              percent: Math.round(contextUsage.percent),
              tokens: formatTokens(contextUsage.tokens ?? 0),
              window: formatTokens(contextUsage.contextWindow),
            },
          },
        };
  return {
    view: {
      state: "ready",
      tokens: usage,
      context,
      level:
        contextUsage?.percent === null || contextUsage?.percent === undefined
          ? "neutral"
          : contextLevel(contextUsage.percent),
      stale: status?.statsStale ?? false,
    },
    actions: { compact },
    onKeyDown: () => undefined,
  };
}
