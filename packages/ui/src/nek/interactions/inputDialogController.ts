import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  NekExtensionUiDialogRequest,
  NekExtensionUiResponse,
} from "@zcode/shared/nek-protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import {
  shouldTakeFocus,
  useInteractionFocus,
  type ActionHandle,
  type ActiveElementInfo,
} from "./interactionCommon.js";
import { buildDialogResponse, buildCancelledExtensionUiResponse } from "./extensionUi.js";
import {
  createInputState,
  reduceInput,
  resolveInputKey,
  type InputState,
} from "./extensionDialog.js";
import { useDialogDeadline } from "./dialogDeadline.js";

export interface InputDialogControllerProps {
  request: Extract<NekExtensionUiDialogRequest, { method: "input" }>;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onRespond: (response: NekExtensionUiResponse) => Promise<void> | void;
}

export interface InputDialogController {
  view: {
    title: string;
    placeholder?: string;
    text: string;
    deadline: { remainingMs?: number };
    notice?: InputState["notice"];
    error?: string;
  };
  actions: { submit: ActionHandle; cancel: ActionHandle };
  setText: (text: string) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  focus: ReturnType<typeof useInteractionFocus>;
}

export function useInputDialogController({
  request,
  activeElement,
  isQueueHead = true,
  closedByHost = false,
  onRespond,
}: InputDialogControllerProps): InputDialogController {
  const [state, dispatch] = useReducer(
    (current: InputState, event: Parameters<typeof reduceInput>[1]) => reduceInput(current, event),
    undefined,
    createInputState,
  );
  const focus = useInteractionFocus();
  const operationRef = useRef<"submit" | "cancel" | null>(null);
  const noticeRef = useRef<InputState["notice"]>(undefined);
  const textRef = useRef(state.text);
  textRef.current = state.text;
  const asyncAction = useAsyncAction(
    async () => {
      if (operationRef.current === "submit")
        await onRespond(buildDialogResponse(request, textRef.current));
      else await onRespond(buildCancelledExtensionUiResponse(request.id));
    },
    {
      successFeedbackMs: 0,
      onSuccess: () =>
        dispatch({ type: "close", ...(noticeRef.current ? { notice: noticeRef.current } : {}) }),
    },
  );
  const pending = asyncAction.state.status === "pending";
  const run = useCallback(
    async (operation: "submit" | "cancel") => {
      if (pending || state.closed) return;
      operationRef.current = operation;
      noticeRef.current = undefined;
      await asyncAction.run();
    },
    [asyncAction, pending, state.closed],
  );
  const submit = useCallback(async () => run("submit"), [run]);
  const cancel = useCallback(async () => run("cancel"), [run]);
  const onTimeout = useCallback(() => {
    noticeRef.current = "nek.interaction.timedOut";
    void run("cancel");
  }, [run]);
  const deadline = useDialogDeadline({ timeout: request.timeout, onExpired: onTimeout });
  const setText = useCallback((text: string) => dispatch({ type: "setText", text }), []);

  useEffect(() => {
    if (closedByHost && !state.closed)
      dispatch({ type: "close", notice: "nek.interaction.cancelledByHost" });
  }, [closedByHost, state.closed]);
  useEffect(() => {
    if (isQueueHead && shouldTakeFocus(activeElement)) focus.setTarget("input");
  }, [activeElement, focus.setTarget, isQueueHead]);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const command = resolveInputKey({
        key: event.key,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        focusTarget: "input",
      });
      if (!command) return;
      event.preventDefault();
      if (command === "cancel") {
        event.stopPropagation();
        void cancel();
      } else void submit();
    },
    [cancel, submit],
  );
  const error = asyncAction.state.status === "error" ? asyncAction.state.message : undefined;
  const actions = useMemo(
    () =>
      ({
        submit: {
          visible: true,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: pending && operationRef.current === "submit",
          ...(error && operationRef.current === "submit" ? { error } : {}),
          primary: true,
          run: submit,
        },
        cancel: {
          visible: true,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: pending && operationRef.current === "cancel",
          ...(error && operationRef.current === "cancel" ? { error } : {}),
          run: cancel,
        },
      }) satisfies InputDialogController["actions"],
    [cancel, error, pending, submit],
  );

  return {
    view: {
      title: request.title,
      ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
      text: state.text,
      deadline,
      ...(state.notice ? { notice: state.notice } : {}),
      ...(error ? { error } : {}),
    },
    actions,
    setText,
    onKeyDown,
    focus,
  };
}
