import type { NekAskQuestionPayload } from "@zcode/shared/nek-protocol";
import {
  ASYNC_ACTION_IDLE,
  reduceAsyncAction,
  type AsyncActionEvent,
  type AsyncActionState,
} from "@/lib/asyncAction.js";

export interface AskQuestionDraftState {
  selected: string[];
  other: string;
}

export type AskQuestionClosedReason = "completed" | "cancelled" | "cancelledByHost";

export interface AskQuestionState {
  questionIndex: number;
  drafts: Readonly<Record<string, AskQuestionDraftState>>;
  active: number;
  submit: AsyncActionState;
  closed: AskQuestionClosedReason | null;
  notice: "nek.interaction.cancelledByHost" | null;
}

export type AskQuestionEvent =
  | { type: "selectOption"; optionId: string }
  | { type: "setOther"; value: string }
  | { type: "setQuestion"; index: number }
  | { type: "setActive"; active: number }
  | { type: "submit"; event: AsyncActionEvent }
  | { type: "close"; reason: Exclude<AskQuestionClosedReason, "cancelledByHost"> }
  | { type: "hostCancel" };

function createDrafts(
  payload: NekAskQuestionPayload,
): Readonly<Record<string, AskQuestionDraftState>> {
  return Object.fromEntries(
    payload.questions.map((question) => [question.id, { selected: [], other: "" }]),
  );
}

export function createAskQuestionState(payload: NekAskQuestionPayload): AskQuestionState {
  return {
    questionIndex: 0,
    drafts: createDrafts(payload),
    active: -1,
    submit: ASYNC_ACTION_IDLE,
    closed: null,
    notice: null,
  };
}

function questionAt(payload: NekAskQuestionPayload, index: number) {
  return payload.questions[index];
}

function currentDraft(
  state: AskQuestionState,
  payload: NekAskQuestionPayload,
): AskQuestionDraftState {
  const question = questionAt(payload, state.questionIndex);
  return question
    ? (state.drafts[question.id] ?? { selected: [], other: "" })
    : { selected: [], other: "" };
}

function withCurrentDraft(
  state: AskQuestionState,
  payload: NekAskQuestionPayload,
  draft: AskQuestionDraftState,
): AskQuestionState {
  const question = questionAt(payload, state.questionIndex);
  if (!question) return state;
  return { ...state, drafts: { ...state.drafts, [question.id]: draft } };
}

/** Pure AQ reducer. Illegal events return the original reference. */
export function reduceAskQuestion(
  state: AskQuestionState,
  payload: NekAskQuestionPayload,
  event: AskQuestionEvent,
): AskQuestionState {
  if (state.closed !== null && event.type !== "hostCancel") return state;
  switch (event.type) {
    case "selectOption": {
      const question = questionAt(payload, state.questionIndex);
      if (!question || !question.options.some((option) => option.id === event.optionId))
        return state;
      const draft = currentDraft(state, payload);
      if (question.allow_multiple) {
        const selected = draft.selected.includes(event.optionId)
          ? draft.selected.filter((id) => id !== event.optionId)
          : [...draft.selected, event.optionId];
        return withCurrentDraft(
          {
            ...state,
            active: question.options.findIndex((option) => option.id === event.optionId),
          },
          payload,
          {
            ...draft,
            selected,
          },
        );
      }
      return withCurrentDraft(
        { ...state, active: question.options.findIndex((option) => option.id === event.optionId) },
        payload,
        {
          selected: [event.optionId],
          other: "",
        },
      );
    }
    case "setOther": {
      const question = questionAt(payload, state.questionIndex);
      if (!question) return state;
      const draft = currentDraft(state, payload);
      return withCurrentDraft(state, payload, {
        selected: !question.allow_multiple && event.value.trim() ? [] : draft.selected,
        other: event.value,
      });
    }
    case "setQuestion": {
      if (
        !Number.isInteger(event.index) ||
        event.index < 0 ||
        event.index >= payload.questions.length
      )
        return state;
      return { ...state, questionIndex: event.index };
    }
    case "setActive": {
      const question = questionAt(payload, state.questionIndex);
      if (!question || event.active < -1 || event.active > question.options.length) return state;
      return state.active === event.active ? state : { ...state, active: event.active };
    }
    case "submit": {
      const submit = reduceAsyncAction(state.submit, event.event);
      return submit === state.submit ? state : { ...state, submit };
    }
    case "close":
      return state.closed === event.reason ? state : { ...state, closed: event.reason };
    case "hostCancel":
      return state.closed === "cancelledByHost"
        ? state
        : {
            ...state,
            closed: "cancelledByHost",
            notice: "nek.interaction.cancelledByHost",
          };
  }
}

export function isAskQuestionAnswered(draft: AskQuestionDraftState | undefined): boolean {
  return Boolean(draft?.selected.length || draft?.other.trim());
}

export function getAskQuestionActiveForDraft(
  payload: NekAskQuestionPayload,
  index: number,
  drafts: Readonly<Record<string, AskQuestionDraftState>>,
): number {
  const question = payload.questions[index];
  if (!question) return -1;
  const draft = drafts[question.id];
  const selectedIndex = question.options.findIndex((option) => draft?.selected.includes(option.id));
  if (selectedIndex >= 0) return selectedIndex;
  return draft?.other.trim() ? question.options.length : -1;
}
