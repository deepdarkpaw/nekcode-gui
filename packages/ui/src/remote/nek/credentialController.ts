import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  RemotePasswordPrompt,
  RemotePassphrasePrompt,
  RemotePromptResponse,
} from "@zcode/shared/nek-protocol";
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

export type CredentialPrompt = RemotePassphrasePrompt | RemotePasswordPrompt;
export type CredentialFocusId = "input" | "submit" | "cancel";
export type CredentialCommand = { type: "activate"; action: "submit" | "cancel" };

export interface CredentialKeyInput {
  key: string;
  value: string;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export interface CredentialPromptState {
  value: string;
  revealed: boolean;
  closed: boolean;
}

export type CredentialPromptEvent =
  | { type: "setValue"; value: string }
  | { type: "toggleReveal" }
  | { type: "close" };

export const INITIAL_CREDENTIAL_PROMPT_STATE: CredentialPromptState = {
  value: "",
  revealed: false,
  closed: false,
};

export function reduceCredentialPrompt(
  state: CredentialPromptState,
  event: CredentialPromptEvent,
): CredentialPromptState {
  switch (event.type) {
    case "setValue":
      return state.value === event.value ? state : { ...state, value: event.value };
    case "toggleReveal":
      return { ...state, revealed: !state.revealed };
    case "close":
      return state.closed && state.value === "" && !state.revealed
        ? state
        : { value: "", revealed: false, closed: true };
  }
}

export interface CredentialPromptControllerProps {
  open: boolean;
  prompt: CredentialPrompt;
  respond: (id: string, response: RemotePromptResponse) => Promise<void>;
  onClose: () => void;
  activeElement?: ActiveElementInfo;
}

export function resolveCredentialKey(input: CredentialKeyInput): CredentialCommand | null {
  if (isImeComposing(input)) return null;
  if (input.key === "Escape") return { type: "activate", action: "cancel" };
  if (input.key === "Enter" && input.value.length > 0) {
    return { type: "activate", action: "submit" };
  }
  return null;
}

function isPassphrasePrompt(prompt: CredentialPrompt): prompt is RemotePassphrasePrompt {
  return prompt.kind === "passphrase";
}

export function useCredentialPromptController({
  open,
  prompt,
  respond,
  onClose,
  activeElement,
}: CredentialPromptControllerProps) {
  const [interactionState, dispatch] = useReducer(
    reduceCredentialPrompt,
    INITIAL_CREDENTIAL_PROMPT_STATE,
  );
  const value = interactionState.value;
  const revealed = interactionState.revealed;
  const setValue = useCallback(
    (nextValue: string) => dispatch({ type: "setValue", value: nextValue }),
    [],
  );
  const busyRef = useRef(false);
  const focusRestore = useFocusRestore(open);
  const focus = useRemoteInteractionFocus<CredentialFocusId>(
    open,
    "input",
    activeElement,
    prompt.id,
  );

  useEffect(() => {
    if (!open) {
      dispatch({ type: "close" });
    }
  }, [open]);

  const close = useCallback(() => {
    dispatch({ type: "close" });
    onClose();
    focusRestore.restoreFocus();
  }, [focusRestore, onClose]);
  const sendResponse = useCallback(
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
  const submit = useAsyncAction(() => sendResponse({ value }), {
    successFeedbackMs: 0,
    onSuccess: close,
  });
  const cancel = useAsyncAction(() => sendResponse({ cancelled: true }), {
    successFeedbackMs: 0,
    onSuccess: close,
  });
  const toggleReveal = useAsyncAction(
    async () => {
      dispatch({ type: "toggleReveal" });
    },
    { successFeedbackMs: 0 },
  );
  const submitBusy = submit.state.status === "pending" || cancel.state.status === "pending";
  const kindLabel = isPassphrasePrompt(prompt) ? "口令" : "密码";
  const emptyReason: RemoteMessage = {
    id: "remote.nek.credential.empty",
    values: { kind: kindLabel },
  };
  const makeAction = (
    action: "submit" | "cancel" | "toggleReveal",
    state: typeof submit.state,
    enabled: boolean,
    primary = false,
  ): RemoteActionHandle => {
    const runner =
      action === "submit" ? submit.run : action === "cancel" ? cancel.run : toggleReveal.run;
    const disabledReason = enabled
      ? undefined
      : value.length === 0 && action === "submit"
        ? emptyReason
        : disabledReasonForBusy(submitBusy);
    return {
      label: {
        id:
          action === "submit"
            ? "remote.nek.credential.submit"
            : action === "cancel"
              ? "remote.nek.credential.cancel"
              : revealed
                ? "remote.nek.credential.hide"
                : "remote.nek.credential.show",
      },
      visible: true,
      enabled,
      ...(disabledReason ? { disabledReason } : {}),
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
      submit: makeAction("submit", submit.state, value.length > 0 && !submitBusy, true),
      cancel: makeAction("cancel", cancel.state, !submitBusy),
      toggleReveal: makeAction("toggleReveal", toggleReveal.state, !submitBusy),
    }),
    [cancel.state, submit.state, submitBusy, toggleReveal.state, value.length],
  );
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const command = resolveCredentialKey({
        key: event.key,
        value,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.keyCode,
        nativeEvent: event.nativeEvent,
      });
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void actions[command.action].run();
    },
    [actions, value],
  );

  const passphrase = isPassphrasePrompt(prompt);
  const description: RemoteMessage = passphrase
    ? prompt.privateKeyPath
      ? {
          id: "remote.nek.credential.passphrase.description",
          values: { path: prompt.privateKeyPath },
        }
      : { id: "remote.nek.credential.passphrase.descriptionNoPath" }
    : {
        id: "remote.nek.credential.password.description",
        values: { username: prompt.username, host: prompt.host },
      };

  return {
    view: {
      kind: prompt.kind,
      title: {
        id: passphrase
          ? "remote.nek.credential.passphrase.title"
          : "remote.nek.credential.password.title",
      },
      description,
      value,
      revealed,
      toggleRevealLabel: {
        id: revealed ? "remote.nek.credential.hide" : "remote.nek.credential.show",
      },
      attention: focus.attention,
    },
    actions,
    setValue,
    onKeyDown,
    focus: { target: focus.target, ref: focus.ref },
    restoreFocus: focusRestore.restoreFocus,
  };
}
