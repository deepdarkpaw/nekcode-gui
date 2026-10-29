import { useCallback, useMemo, useReducer, useRef } from "react";
import type { RemoteHostKeyPrompt, RemotePromptResponse } from "@zcode/shared/nek-protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import {
  actionError,
  actionPending,
  disabledReasonForBusy,
  shouldTakeFocus,
  useRemoteInteractionFocus,
  type ActiveElementInfo,
  type RemoteActionHandle,
  type RemoteMessage,
} from "./remoteInteraction.js";

export type HostKeyFocusId = "reject" | "trust" | "copyFingerprint";
export type HostKeyCommand = { type: "activate"; action: HostKeyFocusId };

export interface HostKeyKeyInput {
  key: string;
  focusTarget: HostKeyFocusId | null;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export interface HostKeyConfirmView {
  host: string;
  port?: number;
  keyType: string;
  fingerprint: string;
  body: RemoteMessage;
  copied: boolean;
  attention: boolean;
}

export interface HostKeyConfirmState {
  closed: boolean;
  copied: boolean;
}

export type HostKeyConfirmEvent =
  | { type: "trust" }
  | { type: "reject" }
  | { type: "copySucceeded" }
  | { type: "close" };

export const INITIAL_HOST_KEY_CONFIRM_STATE: HostKeyConfirmState = {
  closed: false,
  copied: false,
};

export function reduceHostKeyConfirm(
  state: HostKeyConfirmState,
  event: HostKeyConfirmEvent,
): HostKeyConfirmState {
  switch (event.type) {
    case "trust":
    case "reject":
    case "close":
      return state.closed ? state : { ...state, closed: true };
    case "copySucceeded":
      return state.copied ? state : { ...state, copied: true };
  }
}

export interface HostKeyConfirmControllerProps {
  open: boolean;
  prompt: RemoteHostKeyPrompt;
  respond: (id: string, response: RemotePromptResponse) => Promise<void>;
  copyFingerprint: (fingerprint: string) => Promise<void> | void;
  onClose: () => void;
  activeElement?: ActiveElementInfo;
}

function isHostKeyFocusId(value: string | null): value is HostKeyFocusId {
  return value === "reject" || value === "trust" || value === "copyFingerprint";
}

export function resolveHostKeyConfirmKey(input: HostKeyKeyInput): HostKeyCommand | null {
  if (isImeComposing(input)) return null;
  if (input.key === "Escape") return { type: "activate", action: "reject" };
  if (input.key !== "Enter" || !isHostKeyFocusId(input.focusTarget)) return null;
  return { type: "activate", action: input.focusTarget };
}

export function useHostKeyConfirmController({
  open,
  prompt,
  respond,
  copyFingerprint,
  onClose,
  activeElement,
}: HostKeyConfirmControllerProps) {
  const [interactionState, dispatch] = useReducer(
    reduceHostKeyConfirm,
    INITIAL_HOST_KEY_CONFIRM_STATE,
  );
  const busyRef = useRef(false);
  const focusRestore = useFocusRestore(open);
  const focus = useRemoteInteractionFocus(open, "reject", activeElement, prompt.id);

  const close = useCallback(() => {
    dispatch({ type: "close" });
    onClose();
    focusRestore.restoreFocus();
  }, [focusRestore, onClose]);
  const runResponse = useCallback(
    async (response: RemotePromptResponse) => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await respond(prompt.id, response);
      } finally {
        busyRef.current = false;
      }
    },
    [prompt.id, respond],
  );
  const trust = useAsyncAction(() => runResponse({ accepted: true }), {
    successFeedbackMs: 0,
    onSuccess: close,
  });
  const reject = useAsyncAction(() => runResponse({ accepted: false }), {
    successFeedbackMs: 0,
    onSuccess: close,
  });
  const copy = useAsyncAction(
    async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        await copyFingerprint(prompt.fingerprint);
        dispatch({ type: "copySucceeded" });
      } finally {
        busyRef.current = false;
      }
    },
    { successFeedbackMs: 0 },
  );
  const busy =
    trust.state.status === "pending" ||
    reject.state.status === "pending" ||
    copy.state.status === "pending";
  const busyReason = disabledReasonForBusy(busy);
  const makeAction = (
    action: "trust" | "reject" | "copyFingerprint",
    state: typeof trust.state,
    primary = false,
  ): RemoteActionHandle => {
    const enabled = !busy;
    const runner = action === "trust" ? trust.run : action === "reject" ? reject.run : copy.run;
    return {
      label: {
        id:
          action === "trust"
            ? "remote.nek.hostKey.trust"
            : action === "reject"
              ? "remote.nek.hostKey.reject"
              : "remote.nek.hostKey.copyFingerprint",
      },
      visible: true,
      enabled,
      ...(enabled ? {} : { disabledReason: busyReason ?? { id: "ui.action.busy" } }),
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
      trust: makeAction("trust", trust.state, true),
      reject: makeAction("reject", reject.state),
      copyFingerprint: makeAction("copyFingerprint", copy.state),
    }),
    [busy, copy.state, reject.state, trust.state],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const command = resolveHostKeyConfirmKey({
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
      host: prompt.host,
      port: prompt.port === 22 ? undefined : prompt.port,
      keyType: prompt.keyType,
      fingerprint: prompt.fingerprint,
      body: { id: "remote.nek.hostKey.body" },
      copied: interactionState.copied,
      attention: focus.attention,
    } satisfies HostKeyConfirmView,
    actions,
    onKeyDown,
    focus: { target: focus.target, ref: focus.ref },
    restoreFocus: focusRestore.restoreFocus,
  };
}

export function hostKeyShouldTakeFocus(activeElement: ActiveElementInfo | undefined): boolean {
  return shouldTakeFocus(activeElement);
}
