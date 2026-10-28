import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NekAskQuestionPayload } from "@zcode/shared/nek-protocol";
import { describeAsyncError } from "@/lib/asyncAction.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import {
  shouldTakeFocus,
  useInteractionFocus,
  type ActionHandle,
  type ActiveElementInfo,
} from "./interactionCommon.js";
import { buildAskQuestionResult } from "./askQuestion.js";
import {
  getAskQuestionActiveForDraft,
  createAskQuestionState,
  isAskQuestionAnswered,
  reduceAskQuestion,
  type AskQuestionState,
} from "./askQuestionReducer.js";
import {
  caretLinePosition,
  getAskQuestionOptionTabIndex,
  resolveAskQuestionKey,
  type AskQuestionFocusTarget,
  type AskQuestionKeyCommand,
} from "./askQuestionKeyboard.js";

export interface AskQuestionControllerProps {
  payload: NekAskQuestionPayload;
  queueLength?: number;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onSubmit: (result: ReturnType<typeof buildAskQuestionResult>) => Promise<void> | void;
  onDismiss: () => Promise<void> | void;
}

export interface AskQuestionView {
  title?: string;
  prompt: string;
  progress?: { current: number; total: number };
  drafts: AskQuestionState["drafts"];
  active: number;
  locked: boolean;
  attention: boolean;
  queueLength: number;
  primaryLabelId: "nek.interaction.question.next" | "nek.interaction.question.submit";
  dismissHintId: "nek.interaction.question.dismissHint";
  notice?: "nek.interaction.cancelledByHost";
}

export interface AskQuestionController {
  view: AskQuestionView;
  actions: {
    previous: ActionHandle;
    next: ActionHandle;
    primary: ActionHandle;
    dismiss: ActionHandle;
  };
  onKeyDown: (event: ReactKeyboardEvent) => void;
  selectOption: (index: number) => void;
  focusOther: () => void;
  getOptionTabIndex: (index: number) => 0 | -1;
  focus: ReturnType<typeof useInteractionFocus>;
}

function focusTargetForEvent(
  event: ReactKeyboardEvent,
  state: AskQuestionState,
): AskQuestionFocusTarget {
  const target = event.target;
  if (typeof HTMLElement !== "undefined" && target instanceof HTMLElement) {
    if (target instanceof HTMLButtonElement) return "button";
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return "other";
    const focusTarget = target.dataset.interactionFocus;
    if (focusTarget === "card" || focusTarget === "option" || focusTarget === "other") {
      return focusTarget;
    }
  }
  return state.active >= 0 ? "option" : "card";
}

function draftList(state: AskQuestionState, payload: NekAskQuestionPayload) {
  return payload.questions.map((question) => ({
    questionId: question.id,
    selected: state.drafts[question.id]?.selected ?? [],
    other: state.drafts[question.id]?.other ?? "",
  }));
}

function reason(id: string): { id: string } {
  return { id };
}

export function useAskQuestionController({
  payload,
  queueLength = 0,
  activeElement,
  isQueueHead = true,
  closedByHost = false,
  onSubmit,
  onDismiss,
}: AskQuestionControllerProps): AskQuestionController {
  const [state, dispatch] = useReducer(
    (current: AskQuestionState, event: Parameters<typeof reduceAskQuestion>[2]) =>
      reduceAskQuestion(current, payload, event),
    payload,
    createAskQuestionState,
  );
  const operationRef = useRef<"submit" | "dismiss" | null>(null);
  const submissionRef = useRef<AskQuestionState>(state);
  submissionRef.current = state;
  const asyncAction = useAsyncAction(
    async () => {
      const operation = operationRef.current;
      if (operation === "submit") {
        await onSubmit(buildAskQuestionResult(payload, draftList(submissionRef.current, payload)));
      } else if (operation === "dismiss") {
        await onDismiss();
      }
    },
    {
      successFeedbackMs: 0,
      onSuccess: () => {
        dispatch({
          type: "close",
          reason: operationRef.current === "dismiss" ? "cancelled" : "completed",
        });
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
  const currentQuestion = payload.questions[state.questionIndex];
  const currentDraft = currentQuestion ? state.drafts[currentQuestion.id] : undefined;
  const answered = isAskQuestionAnswered(currentDraft);
  const priorAnswered = payload.questions
    .slice(0, state.questionIndex)
    .every((question) => isAskQuestionAnswered(state.drafts[question.id]));
  const pending = asyncAction.state.status === "pending";
  const lastQuestion = state.questionIndex === payload.questions.length - 1;

  const focusActive = useCallback(
    (nextState: AskQuestionState) => {
      const active = getAskQuestionActiveForDraft(
        payload,
        nextState.questionIndex,
        nextState.drafts,
      );
      const question = payload.questions[nextState.questionIndex];
      dispatch({ type: "setActive", active });
      focus.setTarget(
        active < 0
          ? "card"
          : active === (question?.options.length ?? 0)
            ? "other"
            : `option:${active}`,
      );
    },
    [focus.setTarget, payload],
  );

  useEffect(() => {
    if (closedByHost && state.closed !== "cancelledByHost") dispatch({ type: "hostCancel" });
  }, [closedByHost, state.closed]);

  useEffect(() => {
    if (!isQueueHead) return;
    if (shouldTakeFocus(activeElement)) focus.setTarget("card");
  }, [activeElement, focus.setTarget, isQueueHead]);

  useEffect(() => {
    if (state.active < 0) focus.setTarget("card");
    else if (state.active === (currentQuestion?.options.length ?? 0)) focus.setTarget("other");
    else focus.setTarget(`option:${state.active}`);
  }, [currentQuestion?.options.length, focus.setTarget, state.active]);

  const runOperation = useCallback(
    async (operation: "submit" | "dismiss", nextState = state): Promise<void> => {
      if (pending || state.closed !== null) return;
      operationRef.current = operation;
      submissionRef.current = nextState;
      dispatch({ type: "submit", event: { type: "start" } });
      await asyncAction.run();
    },
    [asyncAction, pending, state],
  );

  const goPrevious = useCallback(async () => {
    if (pending || state.questionIndex <= 0) return;
    const nextState = reduceAskQuestion(state, payload, {
      type: "setQuestion",
      index: state.questionIndex - 1,
    });
    dispatch({ type: "setQuestion", index: state.questionIndex - 1 });
    focusActive(nextState);
  }, [focusActive, payload, pending, state]);

  const goNext = useCallback(async () => {
    if (pending || !answered || lastQuestion) return;
    const nextState = reduceAskQuestion(state, payload, {
      type: "setQuestion",
      index: state.questionIndex + 1,
    });
    dispatch({ type: "setQuestion", index: state.questionIndex + 1 });
    focusActive(nextState);
  }, [answered, focusActive, lastQuestion, payload, pending, state]);

  const selectOption = useCallback(
    (index: number) => {
      if (pending || !currentQuestion?.options[index]) return;
      const optionId = currentQuestion.options[index].id;
      const nextState = reduceAskQuestion(state, payload, { type: "selectOption", optionId });
      dispatch({ type: "selectOption", optionId });
      focus.setTarget(`option:${index}`);
      if (!currentQuestion.allow_multiple) {
        if (lastQuestion) {
          void runOperation("submit", nextState);
        } else {
          const advanced = reduceAskQuestion(nextState, payload, {
            type: "setQuestion",
            index: state.questionIndex + 1,
          });
          dispatch({ type: "setQuestion", index: state.questionIndex + 1 });
          focusActive(advanced);
        }
      }
    },
    [currentQuestion, focus, focusActive, lastQuestion, payload, pending, runOperation, state],
  );

  const focusOther = useCallback(() => {
    if (!pending) {
      dispatch({ type: "setActive", active: currentQuestion?.options.length ?? 0 });
      focus.setTarget("other");
    }
  }, [currentQuestion?.options.length, focus, pending]);

  const runPrimary = useCallback(async () => {
    if (pending || !answered || !priorAnswered || state.closed !== null) return;
    if (!lastQuestion) return goNext();
    await runOperation("submit");
  }, [answered, goNext, lastQuestion, pending, priorAnswered, runOperation, state.closed]);

  const runDismiss = useCallback(async () => {
    await runOperation("dismiss");
  }, [runOperation]);

  const command = useCallback(
    (keyCommand: AskQuestionKeyCommand) => {
      switch (keyCommand.type) {
        case "setActive":
          dispatch({ type: "setActive", active: keyCommand.active });
          return;
        case "selectOption":
          selectOption(keyCommand.index);
          return;
        case "previous":
          void goPrevious();
          return;
        case "dismiss":
          void runDismiss();
          return;
        case "primary":
          void runPrimary();
          return;
        case "noop":
          return;
      }
    },
    [goPrevious, runDismiss, runPrimary, selectOption],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const question = payload.questions[state.questionIndex];
      if (!question) return;
      const caret =
        event.target instanceof HTMLTextAreaElement
          ? caretLinePosition(event.target)
          : { onFirstLine: false, onLastLine: false };
      const keyCommand = resolveAskQuestionKey({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
        keyCode: event.nativeEvent.keyCode,
        focusTarget: focusTargetForEvent(event, state),
        active: state.active,
        optionCount: question.options.length,
        allowMultiple: question.allow_multiple === true,
        questionIndex: state.questionIndex,
        canSubmit: answered && priorAnswered,
        otherValue: currentDraft?.other ?? "",
        caretOnFirstLine: caret.onFirstLine,
        caretOnLastLine: caret.onLastLine,
      });
      if (!keyCommand) return;
      event.preventDefault();
      if (keyCommand.type === "dismiss" || keyCommand.type === "previous") event.stopPropagation();
      command(keyCommand);
    },
    [answered, command, currentDraft?.other, payload.questions, priorAnswered, state],
  );

  const busyReason = reason("ui.action.busy");
  const needAnswerReason = reason("nek.interaction.question.needAnswer");
  const firstReason = reason("nek.interaction.question.firstQuestion");
  const actionError = asyncAction.state.status === "error" ? asyncAction.state.message : undefined;
  const operation = operationRef.current;
  const primaryPending = pending && operation === "submit";
  const dismissPending = pending && operation === "dismiss";
  const actions = useMemo<AskQuestionController["actions"]>(() => {
    const disabled = pending ? busyReason : undefined;
    return {
      previous: {
        visible: payload.questions.length > 1,
        enabled: !pending && state.questionIndex > 0,
        ...(pending
          ? { disabledReason: disabled }
          : state.questionIndex <= 0
            ? { disabledReason: firstReason }
            : {}),
        pending: false,
        run: goPrevious,
      },
      next: {
        visible: payload.questions.length > 1 && !lastQuestion,
        enabled: !pending && answered,
        ...(pending
          ? { disabledReason: disabled }
          : !answered
            ? { disabledReason: needAnswerReason }
            : {}),
        pending: false,
        run: goNext,
      },
      primary: {
        visible: true,
        enabled: !pending && answered && priorAnswered,
        ...(pending
          ? { disabledReason: disabled }
          : !answered || !priorAnswered
            ? { disabledReason: needAnswerReason }
            : {}),
        pending: primaryPending,
        ...(actionError && operation === "submit" ? { error: actionError } : {}),
        primary: true,
        run: runPrimary,
      },
      dismiss: {
        visible: true,
        enabled: !pending,
        ...(pending ? { disabledReason: disabled } : {}),
        pending: dismissPending,
        ...(actionError && operation === "dismiss" ? { error: actionError } : {}),
        run: runDismiss,
      },
    };
  }, [
    actionError,
    answered,
    busyReason,
    firstReason,
    goNext,
    goPrevious,
    lastQuestion,
    needAnswerReason,
    operation,
    payload.questions.length,
    pending,
    primaryPending,
    priorAnswered,
    runDismiss,
    dismissPending,
    runPrimary,
    state.questionIndex,
  ]);

  return {
    view: {
      ...(payload.title ? { title: payload.title } : {}),
      prompt: currentQuestion?.prompt ?? "",
      ...(payload.questions.length > 1
        ? { progress: { current: state.questionIndex + 1, total: payload.questions.length } }
        : {}),
      drafts: state.drafts,
      active: state.active,
      locked: pending,
      attention: Boolean(isQueueHead && !shouldTakeFocus(activeElement)),
      queueLength,
      primaryLabelId: lastQuestion
        ? "nek.interaction.question.submit"
        : "nek.interaction.question.next",
      dismissHintId: "nek.interaction.question.dismissHint",
      ...(state.notice ? { notice: state.notice } : {}),
    },
    actions,
    onKeyDown,
    selectOption,
    focusOther,
    getOptionTabIndex: (index) => getAskQuestionOptionTabIndex(state.active, index),
    focus,
  };
}
