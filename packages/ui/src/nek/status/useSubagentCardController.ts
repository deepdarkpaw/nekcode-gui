import { useEffect, useMemo, useState } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useNowTicker } from "@/hooks/useNowTicker.js";
import { useFoldState } from "@/lib/foldState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekStatusStore } from "./store.js";
import { formatDuration, subagentElapsedMs, subagentMetaParts } from "./format.js";
import { NEK_STATUS_STOP_TIMEOUT_MS, type NekStatusSubagent } from "./types.js";
import type { StatusActionHandle, StatusKeyDown, StatusMessage } from "./controllerTypes.js";
import { ACTION_BUSY } from "./controllerTypes.js";

export interface SubagentCardControllerProps {
  sessionKey: string;
  id: string;
  onStop: (id: string) => Promise<void>;
  onOpenTranscript: (id: string) => Promise<void> | void;
}

export interface SubagentCardView {
  visible: boolean;
  title: string;
  type: string;
  model?: string;
  background: boolean;
  statusId: string;
  tone: "neutral" | "success" | "danger" | "muted";
  metaParts: string[];
  elapsedMs: number;
  elapsed: string;
  activity?: string;
  body?: { text?: string; message?: StatusMessage };
  fold: { id: string; open: boolean; onOpenChange: (open: boolean) => void };
}

export interface SubagentCardController {
  view: SubagentCardView;
  actions: { stop: StatusActionHandle; openTranscript: StatusActionHandle };
  onKeyDown: StatusKeyDown;
}

function statusView(record: NekStatusSubagent): {
  statusId: string;
  tone: SubagentCardView["tone"];
} {
  if (record.status === "running" && record.stopRequested) {
    return { statusId: "nek.status.subagent.stopping", tone: "neutral" };
  }
  switch (record.status) {
    case "running":
      return { statusId: "nek.status.subagent.running", tone: "neutral" };
    case "completed":
      return { statusId: "nek.status.subagent.completed", tone: "success" };
    case "errored":
      return { statusId: "nek.status.subagent.errored", tone: "danger" };
    case "aborted":
      return { statusId: "nek.status.subagent.aborted", tone: "muted" };
  }
}

export function useSubagentCardController({
  sessionKey,
  id,
  onStop,
  onOpenTranscript,
}: SubagentCardControllerProps): SubagentCardController {
  const { intl } = useZCodeIntl();
  const record = useNekStatusStore((state) => state.sessions[sessionKey]?.subagents.byId[id]);
  const markStopRequested = useNekStatusStore((state) => state.markStopRequested);
  const clearStopRequested = useNekStatusStore((state) => state.clearStopRequested);
  const [open, setOpen] = useFoldState(
    `subagent:${id}`,
    "toolOutput",
    record?.status === "errored",
  );
  const [timeoutError, setTimeoutError] = useState<string | undefined>();
  const active = record?.status === "running";
  const now = useNowTicker(active);
  const elapsedMs = record ? subagentElapsedMs(record, now) : 0;

  const stopAction = useAsyncAction(
    async () => {
      setTimeoutError(undefined);
      await onStop(id);
      markStopRequested(sessionKey, id, Date.now());
    },
    { successFeedbackMs: 0 },
  );
  const transcriptAction = useAsyncAction(async () => await onOpenTranscript(id), {
    successFeedbackMs: 0,
  });

  useEffect(() => {
    const stopRequestedAt = record?.stopRequestedAt;
    if (stopRequestedAt === undefined || record?.status !== "running") return;
    if (now - stopRequestedAt < NEK_STATUS_STOP_TIMEOUT_MS) return;
    clearStopRequested(sessionKey, id);
    setTimeoutError(intl.formatMessage({ id: "nek.status.subagent.stopTimeout" }));
  }, [clearStopRequested, id, intl, now, record, sessionKey]);

  const stopPending = stopAction.state.status === "pending";
  const stop = useMemo<StatusActionHandle>(() => {
    const visible = record?.status === "running" && !record.stopRequested;
    const pending = stopPending;
    return {
      visible,
      enabled: visible && !pending,
      ...(visible && !pending ? {} : visible ? { disabledReason: ACTION_BUSY } : {}),
      pending,
      error:
        timeoutError ??
        (stopAction.state.status === "error" ? stopAction.state.message : undefined),
      run: async () => {
        if (!visible || pending) return;
        await stopAction.run();
      },
    };
  }, [record, stopAction, stopPending, timeoutError]);

  const openTranscript = useMemo<StatusActionHandle>(() => {
    const pending = transcriptAction.state.status === "pending";
    return {
      visible: true,
      enabled: !pending,
      ...(pending ? { disabledReason: ACTION_BUSY } : {}),
      pending,
      error: transcriptAction.state.status === "error" ? transcriptAction.state.message : undefined,
      run: async () => {
        if (pending) return;
        await transcriptAction.run();
      },
    };
  }, [transcriptAction]);

  const view = useMemo<SubagentCardView>(() => {
    if (!record) {
      return {
        visible: false,
        title: "",
        type: "",
        background: false,
        statusId: "",
        tone: "muted",
        metaParts: [],
        elapsedMs: 0,
        elapsed: formatDuration(0),
        fold: { id: `subagent:${id}`, open: false, onOpenChange: setOpen },
      };
    }
    const status = statusView(record);
    const body =
      record.status === "completed"
        ? record.finalText
          ? { text: record.finalText }
          : undefined
        : record.status === "errored"
          ? record.error
            ? { text: record.error }
            : undefined
          : record.status === "aborted"
            ? { message: { id: "nek.status.subagent.abortedBody" } }
            : undefined;
    return {
      visible: true,
      title: record.description,
      type: record.type,
      ...(record.model ? { model: record.model } : {}),
      background: record.background,
      statusId: status.statusId,
      tone: status.tone,
      metaParts: subagentMetaParts(record, elapsedMs),
      elapsedMs,
      elapsed: formatDuration(elapsedMs),
      ...(record.status === "running" && record.activity ? { activity: record.activity } : {}),
      ...(body ? { body } : {}),
      fold: { id: `subagent:${id}`, open, onOpenChange: setOpen },
    };
  }, [elapsedMs, id, open, record, setOpen]);

  return { view, actions: { stop, openTranscript }, onKeyDown: () => undefined };
}
