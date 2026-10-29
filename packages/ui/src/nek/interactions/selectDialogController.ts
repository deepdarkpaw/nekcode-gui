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
  createSelectState,
  filterSelectOptions,
  reduceSelect,
  resolveSelectKey,
  type SelectState,
} from "./extensionDialog.js";
import { useDialogDeadline } from "./dialogDeadline.js";

export interface SelectDialogControllerProps {
  request: Extract<NekExtensionUiDialogRequest, { method: "select" }>;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onRespond: (response: NekExtensionUiResponse) => Promise<void> | void;
}

export interface SelectDialogController {
  view: {
    title: string;
    filter: string;
    items: Array<{ value: string; index: number }>;
    highlighted: number;
    empty: boolean;
    deadline: { remainingMs?: number };
    notice?: SelectState["notice"];
    error?: string;
  };
  actions: { cancel: ActionHandle };
  setFilter: (value: string) => void;
  highlight: (index: number) => void;
  select: (index: number) => Promise<void>;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  focus: ReturnType<typeof useInteractionFocus>;
}

export function useSelectDialogController({
  request,
  activeElement,
  isQueueHead = true,
  closedByHost = false,
  onRespond,
}: SelectDialogControllerProps): SelectDialogController {
  const [state, dispatch] = useReducer(
    (current: SelectState, event: Parameters<typeof reduceSelect>[1]) =>
      reduceSelect(current, event),
    undefined,
    createSelectState,
  );
  const focus = useInteractionFocus();
  const operationRef = useRef<"select" | "cancel" | null>(null);
  const selectionRef = useRef<string | null>(null);
  const noticeRef = useRef<SelectState["notice"]>(undefined);
  const items = useMemo(
    () => filterSelectOptions(request.options, state.filter),
    [request.options, state.filter],
  );
  const asyncAction = useAsyncAction(
    async () => {
      if (operationRef.current === "select") {
        if (selectionRef.current !== null) {
          await onRespond(buildDialogResponse(request, selectionRef.current));
        }
      } else {
        await onRespond(buildCancelledExtensionUiResponse(request.id));
      }
    },
    {
      successFeedbackMs: 0,
      onSuccess: () =>
        dispatch({ type: "close", ...(noticeRef.current ? { notice: noticeRef.current } : {}) }),
    },
  );
  const pending = asyncAction.state.status === "pending";
  const cancel = useCallback(async () => {
    if (pending || state.closed) return;
    operationRef.current = "cancel";
    noticeRef.current = undefined;
    await asyncAction.run();
  }, [asyncAction, pending, state.closed]);
  const select = useCallback(
    async (index: number) => {
      if (pending || state.closed || !items[index]) return;
      dispatch({ type: "highlight", index, itemCount: items.length });
      selectionRef.current = items[index]?.value ?? null;
      operationRef.current = "select";
      noticeRef.current = undefined;
      await asyncAction.run();
    },
    [asyncAction, items, pending, state.closed],
  );
  const onTimeout = useCallback(() => {
    noticeRef.current = "nek.interaction.timedOut";
    void cancel();
  }, [cancel]);
  const deadline = useDialogDeadline({ timeout: request.timeout, onExpired: onTimeout });

  useEffect(() => {
    if (closedByHost && !state.closed) {
      noticeRef.current = "nek.interaction.cancelledByHost";
      dispatch({ type: "close", notice: "nek.interaction.cancelledByHost" });
    }
  }, [closedByHost, state.closed]);
  useEffect(() => {
    if (isQueueHead && shouldTakeFocus(activeElement)) focus.setTarget("filter");
  }, [activeElement, focus.setTarget, isQueueHead]);

  const setFilter = useCallback(
    (value: string) =>
      dispatch({
        type: "setFilter",
        value,
        itemCount: filterSelectOptions(request.options, value).length,
      }),
    [request.options],
  );
  const highlight = useCallback(
    (index: number) => dispatch({ type: "highlight", index, itemCount: items.length }),
    [items.length],
  );
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const command = resolveSelectKey({
        key: event.key,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        focusTarget: "filter",
        filter: state.filter,
        highlighted: state.highlighted,
      });
      if (!command) return;
      event.preventDefault();
      if (command === "next") dispatch({ type: "move", delta: 1, itemCount: items.length });
      else if (command === "previous")
        dispatch({ type: "move", delta: -1, itemCount: items.length });
      else if (command === "clearFilter") setFilter("");
      else if (command === "cancel") {
        event.stopPropagation();
        void cancel();
      } else if (command === "select" && state.highlighted >= 0) {
        void select(state.highlighted);
      }
    },
    [cancel, items.length, setFilter, select, state.filter, state.highlighted],
  );

  const error = asyncAction.state.status === "error" ? asyncAction.state.message : undefined;
  return {
    view: {
      title: request.title,
      filter: state.filter,
      items,
      highlighted: state.highlighted,
      empty: items.length === 0,
      deadline,
      ...(state.notice ? { notice: state.notice } : {}),
      ...(error ? { error } : {}),
    },
    actions: {
      cancel: {
        visible: true,
        enabled: !pending,
        ...(pending ? { disabledReason: { id: "ui.action.busy" } } : {}),
        pending: pending && operationRef.current === "cancel",
        run: cancel,
      },
    },
    setFilter,
    highlight,
    select,
    onKeyDown,
    focus,
  };
}
