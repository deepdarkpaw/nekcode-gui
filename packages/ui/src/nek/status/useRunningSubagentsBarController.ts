import { useCallback, useMemo, useRef, useState } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useNowTicker } from "@/hooks/useNowTicker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ACTION_BUSY, type StatusActionHandle, type StatusKeyDown } from "./controllerTypes.js";
import { formatDuration, getRunningSubagents, subagentElapsedMs } from "./format.js";
import { useNekStatusStore } from "./store.js";
import type { NekStatusSubagent } from "./types.js";

export interface RunningSubagentsBarControllerProps {
  sessionKey: string;
  onStop: (id: string) => Promise<void>;
  onStopAll?: (ids: string[]) => Promise<void>;
  onFocusSubagent: (id: string) => void;
}

export interface RunningSubagentBarItem {
  id: string;
  description: string;
  type: string;
  elapsedMs: number;
  elapsed: string;
  stop: StatusActionHandle;
  focus: () => void;
}

export interface RunningSubagentsBarController {
  view: {
    visible: boolean;
    items: RunningSubagentBarItem[];
    overflow: number;
    expanded: boolean;
  };
  actions: {
    toggleExpand: StatusActionHandle;
    stopAll: StatusActionHandle;
  };
  onKeyDown: StatusKeyDown;
}

function runningItems(
  status: ReturnType<typeof useNekStatusStore.getState>["sessions"][string] | undefined,
): NekStatusSubagent[] {
  if (!status) return [];
  return getRunningSubagents(
    status.subagents.order
      .map((id) => status.subagents.byId[id])
      .filter((item): item is NekStatusSubagent => item !== undefined),
  );
}

export function useRunningSubagentsBarController({
  sessionKey,
  onStop,
  onStopAll: _onStopAll,
  onFocusSubagent,
}: RunningSubagentsBarControllerProps): RunningSubagentsBarController {
  const { intl } = useZCodeIntl();
  const status = useNekStatusStore((state) => state.sessions[sessionKey]);
  const markStopRequested = useNekStatusStore((state) => state.markStopRequested);
  const [expanded, setExpanded] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const activeStopIdRef = useRef<string | null>(null);
  const now = useNowTicker(runningItems(status).length > 0);

  const stopAction = useAsyncAction(
    async (id: string) => {
      setErrors((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await onStop(id);
      markStopRequested(sessionKey, id, Date.now());
    },
    {
      successFeedbackMs: 0,
      onError: (error) => {
        const id = activeStopIdRef.current;
        if (!id) return;
        const message = error instanceof Error ? error.message : String(error);
        setErrors((current) => ({ ...current, [id]: message }));
      },
    },
  );

  const stopAllAction = useAsyncAction(
    async (ids: string[]) => {
      const results = await Promise.allSettled(ids.map((id) => onStop(id)));
      const entries = results
        .map((result, index) => ({ result, id: ids[index] }))
        .filter(
          (entry): entry is { result: PromiseSettledResult<void>; id: string } =>
            entry.id !== undefined,
        );
      const failed = entries.filter(
        (entry): entry is { result: PromiseRejectedResult; id: string } =>
          entry.result.status === "rejected",
      );
      for (const entry of entries) {
        if (entry.result.status === "fulfilled") {
          markStopRequested(sessionKey, entry.id, Date.now());
        } else {
          const message =
            entry.result.reason instanceof Error
              ? entry.result.reason.message
              : String(entry.result.reason);
          setErrors((current) => ({ ...current, [entry.id]: message }));
        }
      }
      if (failed.length > 0) {
        throw new Error(
          intl.formatMessage({ id: "nek.status.subagent.stopAllFailed" }, { count: failed.length }),
        );
      }
    },
    { successFeedbackMs: 0 },
  );

  const runStop = useCallback(
    async (id: string) => {
      if (stopAction.state.status === "pending") return;
      activeStopIdRef.current = id;
      setPendingIds((current) => new Set(current).add(id));
      try {
        await stopAction.run(id);
      } finally {
        activeStopIdRef.current = null;
        setPendingIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [stopAction],
  );

  const records = runningItems(status);
  const visibleRecords = expanded ? records : records.slice(0, 3);
  const itemViews = useMemo(
    () =>
      visibleRecords.map((record) => {
        const pending = pendingIds.has(record.id);
        const stop: StatusActionHandle = {
          visible: true,
          enabled: !pending && stopAction.state.status !== "pending",
          ...(!pending && stopAction.state.status !== "pending"
            ? {}
            : { disabledReason: ACTION_BUSY }),
          pending,
          error: errors[record.id],
          run: async () => await runStop(record.id),
        };
        return {
          id: record.id,
          description: record.description,
          type: record.type,
          elapsedMs: subagentElapsedMs(record, now),
          elapsed: formatDuration(subagentElapsedMs(record, now)),
          stop,
          focus: () => onFocusSubagent(record.id),
        };
      }),
    [errors, now, onFocusSubagent, pendingIds, runStop, stopAction.state.status, visibleRecords],
  );

  const toggleExpand: StatusActionHandle = {
    visible: records.length > 3,
    enabled: records.length > 3,
    pending: false,
    run: async () => setExpanded((current) => !current),
  };
  const stopAllVisible = records.length >= 2;
  const stopAllPending = stopAllAction.state.status === "pending";
  const stopAll: StatusActionHandle = {
    visible: stopAllVisible,
    enabled: stopAllVisible && !stopAllPending,
    ...(stopAllVisible && !stopAllPending
      ? {}
      : stopAllVisible
        ? { disabledReason: ACTION_BUSY }
        : {}),
    pending: stopAllPending,
    error: stopAllAction.state.status === "error" ? stopAllAction.state.message : undefined,
    run: async () => {
      if (!stopAllVisible || stopAllPending) return;
      const ids = records.map((record) => record.id);
      setPendingIds(new Set(ids));
      try {
        await stopAllAction.run(ids);
      } finally {
        setPendingIds(new Set());
      }
    },
  };

  return {
    view: {
      visible: records.length > 0,
      items: itemViews,
      overflow: Math.max(0, records.length - 3),
      expanded,
    },
    actions: { toggleExpand, stopAll },
    onKeyDown: () => undefined,
  };
}
