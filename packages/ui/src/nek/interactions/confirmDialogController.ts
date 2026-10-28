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
import {
  createConfirmState,
  reduceConfirm,
  resolveConfirmKey,
  type ConfirmState,
} from "./extensionDialog.js";
import { useDialogDeadline } from "./dialogDeadline.js";

export interface ConfirmDialogControllerProps {
  request: Extract<NekExtensionUiDialogRequest, { method: "confirm" }>;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onRespond: (response: NekExtensionUiResponse) => Promise<void> | void;
}

export interface ConfirmDialogController {
  view: {
    title: string;
    message: string;
    deadline: { remainingMs?: number };
    notice?: ConfirmState["notice"];
    error?: string;
  };
  actions: { confirm: ActionHandle; cancel: ActionHandle };
  onKeyDown: (event: ReactKeyboardEvent) => void;
  focus: ReturnType<typeof useInteractionFocus>;
}

export function useConfirmDialogController({
  request,
  activeElement,
  isQueueHead = true,
  closedByHost = false,
  onRespond,
}: ConfirmDialogControllerProps): ConfirmDialogController {
  const [state, dispatch] = useReducer(
    (current: ConfirmState, event: { type: "close"; notice?: ConfirmState["notice"] }) =>
      reduceConfirm(current, event),
    undefined,
    createConfirmState,
  );
  const focus = useInteractionFocus();
  const operationRef = useRef<"confirm" | "cancel" | null>(null);
  const noticeRef = useRef<ConfirmState["notice"]>(undefined);
  const asyncAction = useAsyncAction(
    async () => {
      if (operationRef.current === "confirm")
        await onRespond({ type: "extension_ui_response", id: request.id, confirmed: true });
      else await onRespond({ type: "extension_ui_response", id: request.id, confirmed: false });
    },
    {
      successFeedbackMs: 0,
      onSuccess: () =>
        dispatch({ type: "close", ...(noticeRef.current ? { notice: noticeRef.current } : {}) }),
    },
  );
  const pending = asyncAction.state.status === "pending";
  const run = useCallback(
    async (operation: "confirm" | "cancel") => {
      if (pending || state.closed) return;
      operationRef.current = operation;
      noticeRef.current = undefined;
      await asyncAction.run();
    },
    [asyncAction, pending, state.closed],
  );
  const confirm = useCallback(async () => run("confirm"), [run]);
  const cancel = useCallback(async () => run("cancel"), [run]);
  const onTimeout = useCallback(() => {
    noticeRef.current = "nek.interaction.timedOut";
    void run("cancel");
  }, [run]);
  const deadline = useDialogDeadline({ timeout: request.timeout, onExpired: onTimeout });

  useEffect(() => {
    if (closedByHost && !state.closed)
      dispatch({ type: "close", notice: "nek.interaction.cancelledByHost" });
  }, [closedByHost, state.closed]);
  useEffect(() => {
    if (isQueueHead && shouldTakeFocus(activeElement)) focus.setTarget("cancel");
  }, [activeElement, focus.setTarget, isQueueHead]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const target = event.target instanceof HTMLButtonElement ? "button" : "card";
      const command = resolveConfirmKey({
        key: event.key,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        focusTarget: target,
      });
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void cancel();
    },
    [cancel],
  );
  const error = asyncAction.state.status === "error" ? asyncAction.state.message : undefined;
  const actions = useMemo(
    () =>
      ({
        confirm: {
          visible: true,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: pending && operationRef.current === "confirm",
          ...(error && operationRef.current === "confirm" ? { error } : {}),
          primary: true,
          run: confirm,
        },
        cancel: {
          visible: true,
          enabled: !pending,
          ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
          pending: pending && operationRef.current === "cancel",
          ...(error && operationRef.current === "cancel" ? { error } : {}),
          run: cancel,
        },
      }) satisfies ConfirmDialogController["actions"],
    [cancel, confirm, error, pending],
  );

  return {
    view: {
      title: request.title,
      message: request.message,
      deadline,
      ...(state.notice ? { notice: state.notice } : {}),
      ...(error ? { error } : {}),
    },
    actions,
    onKeyDown,
    focus,
  };
}
