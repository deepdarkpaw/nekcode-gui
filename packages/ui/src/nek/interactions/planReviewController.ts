import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NekPlanReviewPayload } from "@zcode/shared/nek-protocol";
import { describeAsyncError } from "@/lib/asyncAction.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useFoldState } from "@/lib/foldState.js";
import {
  shouldTakeFocus,
  useInteractionFocus,
  type ActionHandle,
  type ActiveElementInfo,
} from "./interactionCommon.js";
import { buildPlanReviewResult, type PlanReviewResult } from "./structuredResults.js";
import {
  createPlanReviewState,
  reducePlanReview,
  type PlanReviewState,
} from "./planReviewReducer.js";
import { resolvePlanReviewKey, type PlanReviewFocusTarget } from "./planReviewKeyboard.js";

export type PlanReviewSubmission = PlanReviewResult | { cancelled: true };

export interface PlanReviewControllerProps {
  payload: NekPlanReviewPayload;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onSubmit: (submission: PlanReviewSubmission) => Promise<void> | void;
  onOpenPlanFile: (path: string) => Promise<void> | void;
  focusComposer: () => void;
}

export interface PlanReviewView {
  name: string;
  overview: string;
  markdown: string;
  bodyPreviewLines?: string[];
  todos: Array<{ id: string; content: string }>;
  todoCount: number;
  path: string;
  revision: number;
  expanded: boolean;
  bodyKey: string;
  attention: boolean;
  notice?: "nek.interaction.cancelledByHost";
}

export interface PlanReviewController {
  view: PlanReviewView;
  actions: {
    exit: ActionHandle;
    later: ActionHandle;
    keepPlanning: ActionHandle;
    implementFresh: ActionHandle;
    implement: ActionHandle;
    openFile: ActionHandle;
    toggleBody: ActionHandle;
  };
  actionOrder: readonly ["exit", "later", "keepPlanning", "implementFresh", "implement"];
  onKeyDown: (event: ReactKeyboardEvent) => void;
  focus: ReturnType<typeof useInteractionFocus>;
}

function focusTargetForEvent(event: ReactKeyboardEvent): PlanReviewFocusTarget {
  const target = event.target;
  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    if (target instanceof HTMLButtonElement) return "button";
    if (target instanceof HTMLTextAreaElement || target.isContentEditable) return "multiline";
    if (target.dataset.interactionFocus === "multiline") return "multiline";
  }
  return "card";
}

function actionReason(id: string): { id: string } {
  return { id };
}

export function usePlanReviewController({
  payload,
  activeElement,
  isQueueHead = true,
  closedByHost = false,
  onSubmit,
  onOpenPlanFile,
  focusComposer,
}: PlanReviewControllerProps): PlanReviewController {
  const [state, dispatch] = useReducer(
    (current: PlanReviewState, event: Parameters<typeof reducePlanReview>[1]) =>
      reducePlanReview(current, event),
    payload.markdown,
    createPlanReviewState,
  );
  const bodyKey = `plan-review:${payload.path}:${payload.revision}`;
  const [expanded, setExpanded] = useFoldState(bodyKey, null, state.expanded);
  const operationRef = useRef<
    "implement" | "implement_fresh" | "keep_planning" | "exit" | "later" | null
  >(null);
  const asyncAction = useAsyncAction(
    async () => {
      const operation = operationRef.current;
      if (operation === "later") {
        await onSubmit({ cancelled: true });
      } else if (operation) {
        await onSubmit(buildPlanReviewResult(operation));
      }
    },
    {
      successFeedbackMs: 0,
      onSuccess: () => {
        const operation = operationRef.current;
        if (operation === "later" || operation === "keep_planning") focusComposer();
        dispatch({ type: "close" });
      },
      onError: (error) => {
        dispatch({
          type: "submit",
          event: { type: "reject", message: describeAsyncError(error, "Interaction failed.") },
        });
      },
    },
  );
  const focus = useInteractionFocus();
  const pending = asyncAction.state.status === "pending";
  const actionError = asyncAction.state.status === "error" ? asyncAction.state.message : undefined;
  const operation = operationRef.current;

  useEffect(() => {
    if (closedByHost && !state.closed) dispatch({ type: "hostCancel" });
  }, [closedByHost, state.closed]);

  useEffect(() => {
    if (isQueueHead && shouldTakeFocus(activeElement)) focus.setTarget("implement");
  }, [activeElement, focus.setTarget, isQueueHead]);

  const runSubmit = useCallback(
    async (nextOperation: NonNullable<typeof operationRef.current>): Promise<void> => {
      if (pending || state.closed) return;
      operationRef.current = nextOperation;
      dispatch({ type: "submit", event: { type: "start" } });
      await asyncAction.run();
    },
    [asyncAction, pending, state.closed],
  );

  const openFile = useCallback(async () => {
    await onOpenPlanFile(payload.path);
  }, [onOpenPlanFile, payload.path]);

  const toggleBody = useCallback(async () => {
    setExpanded(!expanded);
    dispatch({ type: "toggleBody" });
  }, [expanded, setExpanded]);

  const implement = useCallback(async () => runSubmit("implement"), [runSubmit]);
  const implementFresh = useCallback(async () => runSubmit("implement_fresh"), [runSubmit]);
  const keepPlanning = useCallback(async () => runSubmit("keep_planning"), [runSubmit]);
  const exit = useCallback(async () => runSubmit("exit"), [runSubmit]);
  const later = useCallback(async () => runSubmit("later"), [runSubmit]);

  const command = useCallback(
    (key: "implement" | "later") => {
      if (key === "implement") void implement();
      else void later();
    },
    [implement, later],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const key = resolvePlanReviewKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        focusTarget: focusTargetForEvent(event),
      });
      if (!key) return;
      event.preventDefault();
      if (key === "later") event.stopPropagation();
      command(key);
    },
    [command],
  );

  const busy = actionReason("ui.action.busy");
  const action = useMemo(() => {
    const handle = (
      run: () => Promise<void>,
      id: typeof operation,
      primary = false,
      destructive = false,
    ): ActionHandle => ({
      visible: true,
      enabled: !pending,
      ...(pending ? { disabledReason: busy } : {}),
      pending: pending && operation === id,
      ...(actionError && operation === id ? { error: actionError } : {}),
      ...(primary ? { primary: true } : {}),
      ...(destructive ? { destructive: true } : {}),
      run,
    });
    return {
      exit: handle(exit, "exit"),
      later: handle(later, "later"),
      keepPlanning: handle(keepPlanning, "keep_planning"),
      implementFresh: handle(implementFresh, "implement_fresh"),
      implement: handle(implement, "implement", true),
      openFile: { visible: true, enabled: true, pending: false, run: openFile },
      toggleBody: { visible: true, enabled: true, pending: false, run: toggleBody },
    };
  }, [
    actionError,
    busy,
    exit,
    implement,
    implementFresh,
    keepPlanning,
    later,
    openFile,
    operation,
    pending,
    toggleBody,
  ]);

  const markdownLines = payload.markdown.split("\n");
  return {
    view: {
      name: payload.name,
      overview: payload.overview,
      markdown: payload.markdown,
      ...(expanded ? {} : { bodyPreviewLines: markdownLines.slice(0, 12) }),
      todos: payload.todos,
      todoCount: payload.todos.length,
      path: payload.path,
      revision: payload.revision,
      expanded,
      bodyKey,
      attention: Boolean(isQueueHead && !shouldTakeFocus(activeElement)),
      ...(state.notice ? { notice: state.notice } : {}),
    },
    actions: action,
    actionOrder: ["exit", "later", "keepPlanning", "implementFresh", "implement"],
    onKeyDown,
    focus,
  };
}
