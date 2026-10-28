import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NekSwitchModePayload } from "@zcode/shared/nek-protocol";
import { describeAsyncError } from "@/lib/asyncAction.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import {
  shouldTakeFocus,
  useInteractionFocus,
  type ActionHandle,
  type ActiveElementInfo,
} from "./interactionCommon.js";
import { buildSwitchModeResult } from "./structuredResults.js";
import {
  createSwitchModeState,
  reduceSwitchMode,
  type SwitchModeState,
} from "./switchModeReducer.js";
import { resolveSwitchModeKey } from "./switchModeKeyboard.js";

export interface SwitchModeControllerProps {
  payload: NekSwitchModePayload;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onSubmit: (result: ReturnType<typeof buildSwitchModeResult>) => Promise<void> | void;
}

export interface SwitchModeView {
  from: NekSwitchModePayload["from"];
  to: NekSwitchModePayload["to"];
  explanation?: string;
  attention: boolean;
  notice?: "nek.interaction.cancelledByHost";
}

export interface SwitchModeController {
  view: SwitchModeView;
  actions: { approve: ActionHandle; reject: ActionHandle };
  onKeyDown: (event: ReactKeyboardEvent) => void;
  focus: ReturnType<typeof useInteractionFocus>;
}

function actionReason(id: string): { id: string } {
  return { id };
}

export function useSwitchModeController({
  payload,
  activeElement,
  isQueueHead = true,
  closedByHost = false,
  onSubmit,
}: SwitchModeControllerProps): SwitchModeController {
  const [state, dispatch] = useReducer(
    (current: SwitchModeState, event: Parameters<typeof reduceSwitchMode>[1]) =>
      reduceSwitchMode(current, event),
    undefined,
    createSwitchModeState,
  );
  const operationRef = useRef<"approve" | "reject" | null>(null);
  const asyncAction = useAsyncAction(
    async () => {
      await onSubmit(buildSwitchModeResult(operationRef.current === "approve"));
    },
    {
      successFeedbackMs: 0,
      onSuccess: () => dispatch({ type: "close" }),
      onError: (error) =>
        dispatch({
          type: "submit",
          event: { type: "reject", message: describeAsyncError(error, "Interaction failed.") },
        }),
    },
  );
  const focus = useInteractionFocus();
  const pending = asyncAction.state.status === "pending";
  const operation = operationRef.current;
  const actionError = asyncAction.state.status === "error" ? asyncAction.state.message : undefined;

  useEffect(() => {
    if (closedByHost && !state.closed) dispatch({ type: "hostCancel" });
  }, [closedByHost, state.closed]);

  useEffect(() => {
    if (!isQueueHead) return;
    if (shouldTakeFocus(activeElement)) {
      focus.setTarget(payload.to === "plan" ? "approve" : "reject");
    }
  }, [activeElement, focus.setTarget, isQueueHead, payload.to]);

  const run = useCallback(
    async (next: "approve" | "reject") => {
      if (pending || state.closed) return;
      operationRef.current = next;
      dispatch({ type: "submit", event: { type: "start" } });
      await asyncAction.run();
    },
    [asyncAction, pending, state.closed],
  );
  const approve = useCallback(async () => run("approve"), [run]);
  const reject = useCallback(async () => run("reject"), [run]);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const target = event.target instanceof HTMLButtonElement ? "button" : "card";
      const command = resolveSwitchModeKey({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        focusTarget: target,
      });
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void reject();
    },
    [reject],
  );

  const actions = useMemo(() => {
    const busy = actionReason("ui.action.busy");
    return {
      approve: {
        visible: true,
        enabled: !pending,
        ...(pending ? { disabledReason: busy } : {}),
        pending: pending && operation === "approve",
        ...(actionError && operation === "approve" ? { error: actionError } : {}),
        primary: true,
        run: approve,
      },
      reject: {
        visible: true,
        enabled: !pending,
        ...(pending ? { disabledReason: busy } : {}),
        pending: pending && operation === "reject",
        ...(actionError && operation === "reject" ? { error: actionError } : {}),
        run: reject,
      },
    } satisfies SwitchModeController["actions"];
  }, [actionError, approve, operation, pending, reject]);

  return {
    view: {
      from: payload.from,
      to: payload.to,
      ...(payload.explanation?.trim() ? { explanation: payload.explanation } : {}),
      attention: Boolean(isQueueHead && !shouldTakeFocus(activeElement)),
      ...(state.notice ? { notice: state.notice } : {}),
    },
    actions,
    onKeyDown,
    focus,
  };
}
