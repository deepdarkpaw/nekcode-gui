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
  createEditorState,
  reduceEditor,
  resolveEditorKey,
  type EditorState,
} from "./extensionDialog.js";
import { useDialogDeadline } from "./dialogDeadline.js";

export interface EditorDialogControllerProps {
  request: Extract<NekExtensionUiDialogRequest, { method: "editor" }>;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onRespond: (response: NekExtensionUiResponse) => Promise<void> | void;
  onLostText: (text: string) => void;
}

export interface EditorDialogController {
  view: {
    title: string;
    text: string;
    prefill: string;
    dirty: boolean;
    confirmDiscard: boolean;
    deadline: { remainingMs?: number };
    notice?: EditorState["notice"];
    error?: string;
  };
  actions: {
    submit: ActionHandle;
    cancel: ActionHandle;
    discard: ActionHandle;
    keepEditing: ActionHandle;
  };
  setText: (text: string) => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  focus: ReturnType<typeof useInteractionFocus>;
}

function requestTimeout(
  request: Extract<NekExtensionUiDialogRequest, { method: "editor" }>,
): number | undefined {
  if (!("timeout" in request) || typeof request.timeout !== "number") return undefined;
  return request.timeout;
}

export function useEditorDialogController({
  request,
  activeElement,
  isQueueHead = true,
  closedByHost = false,
  onRespond,
  onLostText,
}: EditorDialogControllerProps): EditorDialogController {
  const prefill = request.prefill ?? "";
  const [state, dispatch] = useReducer(
    (current: EditorState, event: Parameters<typeof reduceEditor>[1]) =>
      reduceEditor(current, event),
    prefill,
    createEditorState,
  );
  const focus = useInteractionFocus();
  const operationRef = useRef<"submit" | "cancel" | "discard" | null>(null);
  const noticeRef = useRef<EditorState["notice"]>(undefined);
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
    async (operation: "submit" | "cancel" | "discard") => {
      if (pending || state.closed) return;
      operationRef.current = operation;
      await asyncAction.run();
    },
    [asyncAction, pending, state.closed],
  );
  const submit = useCallback(async () => run("submit"), [run]);
  const cancel = useCallback(async () => {
    if (pending || state.closed) return;
    if (state.text !== state.prefill) {
      dispatch({ type: "requestCancel" });
      focus.setTarget("keepEditing");
      return;
    }
    noticeRef.current = undefined;
    await run("cancel");
  }, [focus.setTarget, pending, run, state.closed, state.prefill, state.text]);
  const discard = useCallback(async () => {
    if (pending || state.closed) return;
    noticeRef.current = undefined;
    await run("discard");
  }, [pending, run, state.closed]);
  const keepEditing = useCallback(async () => {
    if (pending || state.closed) return;
    dispatch({ type: "keepEditing" });
    focus.setTarget("editor");
  }, [focus.setTarget, pending, state.closed]);
  const onTimeout = useCallback(() => {
    if (state.text !== state.prefill) {
      onLostText(state.text);
      noticeRef.current = "nek.interaction.timedOutDiscarded";
    } else {
      noticeRef.current = "nek.interaction.timedOut";
    }
    void run("cancel");
  }, [onLostText, run, state.prefill, state.text]);
  const deadline = useDialogDeadline({ timeout: requestTimeout(request), onExpired: onTimeout });
  const setText = useCallback((text: string) => dispatch({ type: "setText", text }), []);

  useEffect(() => {
    if (closedByHost && !state.closed)
      dispatch({ type: "close", notice: "nek.interaction.cancelledByHost" });
  }, [closedByHost, state.closed]);
  useEffect(() => {
    if (state.confirmDiscard) focus.setTarget("keepEditing");
    else if (isQueueHead && shouldTakeFocus(activeElement)) focus.setTarget("editor");
  }, [activeElement, focus.setTarget, isQueueHead, state.confirmDiscard]);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const command = resolveEditorKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        focusTarget: "editor",
        confirmDiscard: state.confirmDiscard,
      });
      if (!command) return;
      event.preventDefault();
      if (command === "submit") void submit();
      else if (command === "cancel") {
        event.stopPropagation();
        void cancel();
      } else void keepEditing();
    },
    [cancel, keepEditing, state.confirmDiscard, submit],
  );
  const error = asyncAction.state.status === "error" ? asyncAction.state.message : undefined;
  const actions = useMemo(
    () =>
      ({
        submit: {
          visible: !state.confirmDiscard,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: pending && operationRef.current === "submit",
          ...(error && operationRef.current === "submit" ? { error } : {}),
          primary: true,
          run: submit,
        },
        cancel: {
          visible: !state.confirmDiscard,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: pending && operationRef.current === "cancel",
          ...(error && operationRef.current === "cancel" ? { error } : {}),
          run: cancel,
        },
        discard: {
          visible: state.confirmDiscard,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: pending && operationRef.current === "discard",
          ...(error && operationRef.current === "discard" ? { error } : {}),
          destructive: true,
          run: discard,
        },
        keepEditing: {
          visible: state.confirmDiscard,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: false,
          run: keepEditing,
        },
      }) satisfies EditorDialogController["actions"],
    [cancel, discard, error, keepEditing, pending, state.confirmDiscard, submit],
  );

  return {
    view: {
      title: request.title,
      text: state.text,
      prefill,
      dirty: state.text !== prefill,
      confirmDiscard: state.confirmDiscard,
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
