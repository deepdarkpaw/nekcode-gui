import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import { useNekStatusStore } from "./store.js";
import { NEK_STATUS_TRANSCRIPT_MAX_MESSAGES, NEK_STATUS_TRANSCRIPT_REFRESH_MS } from "./types.js";
import type { StatusActionHandle, StatusKeyDown } from "./controllerTypes.js";
import { ACTION_BUSY } from "./controllerTypes.js";

export interface SubagentTranscriptControllerProps {
  sessionKey: string;
  id: string;
  fetchTranscript: (id: string) => Promise<{ messages: unknown[] }>;
  onBack: () => void;
}

export type TranscriptLoadState =
  | { status: "loading" }
  | { status: "loaded"; messages: unknown[]; truncatedCount: number }
  | { status: "error"; message: string };

export interface TranscriptKeyInput {
  key: string;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function resolveTranscriptKey(input: TranscriptKeyInput): "back" | null {
  if (isImeComposing(input)) return null;
  if (
    input.key === "Escape" &&
    !input.altKey &&
    !input.shiftKey &&
    !input.ctrlKey &&
    !input.metaKey
  ) {
    return "back";
  }
  if (
    input.key === "ArrowLeft" &&
    input.altKey === true &&
    !input.shiftKey &&
    !input.ctrlKey &&
    !input.metaKey
  ) {
    return "back";
  }
  return null;
}

export interface SubagentTranscriptController {
  view: {
    state: TranscriptLoadState;
    refreshing: boolean;
    refreshError?: string;
  };
  actions: { back: StatusActionHandle; retry: StatusActionHandle };
  onKeyDown: StatusKeyDown;
}

function trimMessages(messages: unknown[]): { messages: unknown[]; truncatedCount: number } {
  const truncatedCount = Math.max(0, messages.length - NEK_STATUS_TRANSCRIPT_MAX_MESSAGES);
  return {
    messages: messages.slice(-NEK_STATUS_TRANSCRIPT_MAX_MESSAGES),
    truncatedCount,
  };
}

export function useSubagentTranscriptController({
  sessionKey,
  id,
  fetchTranscript,
  onBack,
}: SubagentTranscriptControllerProps): SubagentTranscriptController {
  const record = useNekStatusStore((state) => state.sessions[sessionKey]?.subagents.byId[id]);
  const [state, setState] = useState<TranscriptLoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>();
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const wasRunningRef = useRef(record?.status === "running");
  const load = useCallback(
    async (initial: boolean) => {
      const requestId = ++requestIdRef.current;
      if (initial) setState({ status: "loading" });
      else setRefreshing(true);
      try {
        const result = await fetchTranscript(id);
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        const trimmed = trimMessages(result.messages);
        setState({ status: "loaded", ...trimmed });
        setRefreshError(undefined);
      } catch (error) {
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        const message = error instanceof Error ? error.message : String(error);
        if (initial) setState({ status: "error", message });
        else setRefreshError(message);
      } finally {
        if (mountedRef.current && requestIdRef.current === requestId) setRefreshing(false);
      }
    },
    [fetchTranscript, id],
  );

  useEffect(() => {
    mountedRef.current = true;
    void load(true);
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [load, sessionKey]);

  useEffect(() => {
    if (record?.status !== "running") return undefined;
    const timer = setInterval(() => void load(false), NEK_STATUS_TRANSCRIPT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, record?.status]);

  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    const isRunning = record?.status === "running";
    wasRunningRef.current = isRunning;
    if (wasRunning && !isRunning) void load(false);
  }, [load, record?.status]);

  const retryAction = useAsyncAction(async () => await load(true), { successFeedbackMs: 0 });
  const backAction = useAsyncAction(async () => onBack(), { successFeedbackMs: 0 });
  const backPending = backAction.state.status === "pending";
  const retryPending = retryAction.state.status === "pending";

  const back: StatusActionHandle = useMemo(
    () => ({
      visible: true,
      enabled: !backPending,
      ...(backPending ? { disabledReason: ACTION_BUSY } : {}),
      pending: backPending,
      error: backAction.state.status === "error" ? backAction.state.message : undefined,
      run: async () => {
        if (!backPending) await backAction.run();
      },
    }),
    [backAction, backPending],
  );
  const retry: StatusActionHandle = useMemo(
    () => ({
      visible: state.status === "error",
      enabled: state.status === "error" && !retryPending,
      ...(state.status === "error" && retryPending ? { disabledReason: ACTION_BUSY } : {}),
      pending: retryPending,
      error: retryAction.state.status === "error" ? retryAction.state.message : undefined,
      run: async () => {
        if (state.status === "error" && !retryPending) await retryAction.run();
      },
    }),
    [retryAction, retryPending, state.status],
  );

  return {
    view: { state, refreshing, ...(refreshError ? { refreshError } : {}) },
    actions: { back, retry },
    onKeyDown: (event) => {
      const command = resolveTranscriptKey(event);
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void back.run();
    },
  };
}
