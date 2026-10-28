import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const busyRef = useRef(false);
  const focusRestore = useFocusRestore(open);
  const focus = useRemoteInteractionFocus(open, "input", activeElement, prompt.id);

  useEffect(() => {
    if (!open) {
      setValue("");
      setRevealed(false);
    }
  }, [open]);

  const close = useCallback(() => {
    setValue("");
    setRevealed(false);
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
      setRevealed((current) => !current);
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
    const runner = action === "submit" ? submit.run : action === "cancel" ? cancel.run : toggleReveal.run;
    const disabledReason = enabled ? undefined : value.length === 0 && action === "submit" ? emptyReason : disabledReasonForBusy(submitBusy);
    return {
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
        isComposing: event.isComposing,
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
      ? { id: "remote.nek.credential.passphrase.description", values: { path: prompt.privateKeyPath } }
      : { id: "remote.nek.credential.passphrase.descriptionNoPath" }
    : { id: "remote.nek.credential.password.description", values: { username: prompt.username, host: prompt.host } };

  return {
    view: {
      kind: prompt.kind,
      title: { id: passphrase ? "remote.nek.credential.passphrase.title" : "remote.nek.credential.password.title" },
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
