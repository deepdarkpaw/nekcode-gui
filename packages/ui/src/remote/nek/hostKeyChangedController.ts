import { useCallback, useMemo, useReducer, useRef } from "react";
import type { RemoteHostKeyChangedEvent } from "@zcode/shared/nek-protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import {
  actionError,
  actionPending,
  disabledReasonForBusy,
  useRemoteInteractionFocus,
  type ActiveElementInfo,
  type RemoteActionHandle,
  type RemoteMessage,
} from "./remoteInteraction.js";

export type HostKeyChangedFocusId = "close" | "manageHosts";
export type HostKeyChangedCommand = { type: "activate"; action: HostKeyChangedFocusId };

export interface HostKeyChangedKeyInput {
  key: string;
  focusTarget: HostKeyChangedFocusId | null;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export interface HostKeyChangedState {
  closed: boolean;
}

export type HostKeyChangedEvent = { type: "close" } | { type: "manageHosts" };

export const INITIAL_HOST_KEY_CHANGED_STATE: HostKeyChangedState = { closed: false };

export function reduceHostKeyChanged(
  state: HostKeyChangedState,
  event: HostKeyChangedEvent,
): HostKeyChangedState {
  switch (event.type) {
    case "close":
    case "manageHosts":
      return state.closed ? state : { closed: true };
  }
}

export interface HostKeyChangedControllerProps {
  open: boolean;
  notification: RemoteHostKeyChangedEvent;
  onOpenKnownHosts: (connectionId: string) => Promise<void> | void;
  onClose: () => void;
  activeElement?: ActiveElementInfo;
}

function isHostKeyChangedFocusId(value: string | null): value is HostKeyChangedFocusId {
  return value === "close" || value === "manageHosts";
}

export function resolveHostKeyChangedKey(
  input: HostKeyChangedKeyInput,
): HostKeyChangedCommand | null {
  if (isImeComposing(input)) return null;
  if (input.key === "Escape") return { type: "activate", action: "close" };
  if (input.key !== "Enter" || !isHostKeyChangedFocusId(input.focusTarget)) return null;
  return { type: "activate", action: input.focusTarget };
}

export function useHostKeyChangedController({
  open,
  notification,
  onOpenKnownHosts,
  onClose,
  activeElement,
}: HostKeyChangedControllerProps) {
  const busyRef = useRef(false);
  const [, dispatch] = useReducer(reduceHostKeyChanged, INITIAL_HOST_KEY_CHANGED_STATE);
  const focusRestore = useFocusRestore(open);
  const focus = useRemoteInteractionFocus(open, "close", activeElement, notification.id);
  const close = useCallback(() => {
    dispatch({ type: "close" });
    onClose();
    focusRestore.restoreFocus();
  }, [focusRestore, onClose]);
  const closeAction = useAsyncAction(async () => {}, { successFeedbackMs: 0, onSuccess: close });
  const manageAction = useAsyncAction(
    async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await onOpenKnownHosts(notification.connectionId);
      } finally {
        busyRef.current = false;
      }
    },
    { successFeedbackMs: 0, onSuccess: close },
  );
  const busy = closeAction.state.status === "pending" || manageAction.state.status === "pending";
  const disabledReason = disabledReasonForBusy(busy) ?? { id: "ui.action.busy" };
  const makeAction = (
    action: "close" | "manageHosts",
    state: typeof closeAction.state,
    primary = false,
  ): RemoteActionHandle => {
    const runner = action === "close" ? closeAction.run : manageAction.run;
    const enabled = !busy;
    return {
      label: {
        id:
          action === "close"
            ? "remote.nek.hostKeyChanged.close"
            : "remote.nek.hostKeyChanged.manageHosts",
      },
      visible: true,
      enabled,
      ...(enabled ? {} : { disabledReason }),
      pending: actionPending(state),
      error: actionError(state),
      ...(primary ? { primary: true } : {}),
      run: async () => {
        if (!enabled) return;
        await runner();
      },
    };
  };
  const actions = useMemo(
    () => ({
      close: makeAction("close", closeAction.state, true),
      manageHosts: makeAction("manageHosts", manageAction.state),
    }),
    [busy, closeAction.state, manageAction.state],
  );
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const command = resolveHostKeyChangedKey({
        key: event.key,
        focusTarget: focus.target,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        nativeEvent: event.nativeEvent,
      });
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void actions[command.action].run();
    },
    [actions, focus.target],
  );

  return {
    view: {
      host: notification.host,
      port: notification.port === 22 ? undefined : notification.port,
      keyType: notification.keyType,
      oldFingerprint: notification.oldFingerprint,
      newFingerprint: notification.newFingerprint,
      body: { id: "remote.nek.hostKeyChanged.body" } satisfies RemoteMessage,
      attention: focus.attention,
    },
    actions,
    onKeyDown,
    focus: { target: focus.target, ref: focus.ref },
    restoreFocus: focusRestore.restoreFocus,
  };
}
