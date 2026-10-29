import { useEffect, useMemo, useRef, useState } from "react";
import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import {
  actionError,
  actionPending,
  disabledReasonForBusy,
  type RemoteActionHandle,
  type RemoteMessage,
} from "./remoteInteraction.js";

export interface RemoteConnectionClock {
  now(): number;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemClock: RemoteConnectionClock = {
  now: () => Date.now(),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface RemoteConnectionStatusState {
  connectionId: string;
  kind: RemoteConnectionStatusEvent["kind"];
  attempt?: number;
  max?: number;
  nextDelayMs?: number;
  receivedAt: number;
  message?: string;
}

export interface RemoteConnectionStatusSource {
  (listener: (event: RemoteConnectionStatusEvent) => void): () => void;
}

export interface RemoteConnectionStatusControllerProps {
  connectionId: string;
  onStatus: RemoteConnectionStatusSource;
  retryNow: (connectionId: string) => Promise<void>;
  cancelReconnect: (connectionId: string) => Promise<void>;
  now?: () => number;
  clock?: RemoteConnectionClock;
  onReconnected?: () => void;
}

export function reduceRemoteConnectionStatus(
  state: RemoteConnectionStatusState,
  event: RemoteConnectionStatusEvent,
  receivedAt: number,
): RemoteConnectionStatusState {
  if (event.connectionId !== state.connectionId) return state;
  switch (event.kind) {
    case "connected":
      return { connectionId: state.connectionId, kind: "connected", receivedAt };
    case "disconnected":
      return { connectionId: state.connectionId, kind: "disconnected", receivedAt };
    case "reconnecting":
      return {
        connectionId: state.connectionId,
        kind: "reconnecting",
        attempt: event.attempt,
        max: event.max,
        nextDelayMs: event.nextDelayMs,
        receivedAt,
      };
    case "failed":
      return {
        connectionId: state.connectionId,
        kind: "failed",
        message: event.message,
        receivedAt,
      };
    case "cancelled":
      return { connectionId: state.connectionId, kind: "cancelled", receivedAt };
  }
}

function firstLine(message: string): string {
  return message.split(/\r?\n/u, 1)[0]?.slice(0, 200) ?? "";
}

function buildMessage(
  state: RemoteConnectionStatusState,
  now: number,
): { message: RemoteMessage; failureMessage?: string; seconds?: number } {
  switch (state.kind) {
    case "connected":
      return { message: { id: "remote.nek.status.connected" } };
    case "disconnected":
      return { message: { id: "remote.nek.status.disconnected" } };
    case "reconnecting": {
      const remainingMs = Math.max(0, (state.nextDelayMs ?? 0) - (now - state.receivedAt));
      const seconds = Math.ceil(remainingMs / 1000);
      return {
        seconds,
        message:
          seconds > 0
            ? {
                id: "remote.nek.status.reconnecting",
                values: { seconds, attempt: state.attempt ?? 0, max: state.max ?? 0 },
              }
            : {
                id: "remote.nek.status.reconnectingNow",
                values: { attempt: state.attempt ?? 0, max: state.max ?? 0 },
              },
      };
    }
    case "failed":
      return {
        message: { id: "remote.nek.status.failed" },
        failureMessage: firstLine(state.message ?? ""),
      };
    case "cancelled":
      return { message: { id: "remote.nek.status.cancelled" } };
  }
}

export function useRemoteConnectionStatusController({
  connectionId,
  onStatus,
  retryNow,
  cancelReconnect,
  now,
  clock = systemClock,
  onReconnected,
}: RemoteConnectionStatusControllerProps) {
  const nowFn = now ?? (() => clock.now());
  const [state, setState] = useState<RemoteConnectionStatusState>(() => ({
    connectionId,
    kind: "connected",
    receivedAt: nowFn(),
  }));
  const [nowValue, setNowValue] = useState(() => nowFn());
  const seenStatusRef = useRef(false);
  const previousKindRef = useRef<RemoteConnectionStatusEvent["kind"]>("connected");
  const busyRef = useRef(false);

  useEffect(() => {
    return onStatus((event) => {
      if (event.connectionId !== connectionId) return;
      const receivedAt = nowFn();
      const previousKind = previousKindRef.current;
      previousKindRef.current = event.kind;
      if (event.kind === "connected" && seenStatusRef.current && previousKind !== "connected") {
        onReconnected?.();
      }
      seenStatusRef.current = true;
      setState((current) => reduceRemoteConnectionStatus(current, event, receivedAt));
      setNowValue(receivedAt);
    });
  }, [connectionId, nowFn, onReconnected, onStatus]);

  useEffect(() => {
    if (state.kind !== "reconnecting") return;
    const interval = clock.setInterval(() => setNowValue(nowFn()), 1000);
    return () => clock.clearInterval(interval);
  }, [clock, nowFn, state.kind, state.receivedAt, state.nextDelayMs]);

  const retry = useAsyncAction(
    async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await retryNow(connectionId);
      } finally {
        busyRef.current = false;
      }
    },
    { successFeedbackMs: 0 },
  );
  const cancel = useAsyncAction(
    async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await cancelReconnect(connectionId);
      } finally {
        busyRef.current = false;
      }
    },
    { successFeedbackMs: 0 },
  );
  const busy = retry.state.status === "pending" || cancel.state.status === "pending";
  const busyReason = disabledReasonForBusy(busy) ?? { id: "ui.action.busy" };
  const retryVisible = state.kind !== "connected";
  const cancelVisible = state.kind === "reconnecting";
  const makeAction = (
    action: "retry" | "cancel",
    visible: boolean,
    actionState: typeof retry.state,
    primary: boolean,
  ): RemoteActionHandle => {
    const enabled = visible && !busy;
    const runner = action === "retry" ? retry.run : cancel.run;
    return {
      label: {
        id:
          action === "cancel"
            ? "remote.nek.status.cancel"
            : state.kind === "disconnected" || state.kind === "reconnecting"
              ? "remote.nek.status.retryNow"
              : "remote.nek.status.retry",
      },
      visible,
      enabled,
      ...(visible && !enabled ? { disabledReason: busyReason } : {}),
      pending: actionPending(actionState),
      error: actionError(actionState),
      ...(primary ? { primary: true } : {}),
      run: async () => {
        if (!enabled) return;
        await runner();
      },
    };
  };
  const actions = useMemo(
    () => ({
      retryNow: makeAction("retry", retryVisible, retry.state, true),
      cancel: makeAction("cancel", cancelVisible, cancel.state, false),
    }),
    [busy, cancel.state, cancelVisible, retry.state, retryVisible],
  );
  const presentation = buildMessage(state, nowValue);
  return {
    view: {
      kind: state.kind,
      tone:
        state.kind === "failed"
          ? "danger"
          : state.kind === "cancelled"
            ? "muted"
            : state.kind === "connected"
              ? "neutral"
              : "warning",
      message: presentation.message,
      failureMessage: presentation.failureMessage,
      banner: state.kind !== "connected",
      seconds: presentation.seconds,
    },
    actions,
  };
}
