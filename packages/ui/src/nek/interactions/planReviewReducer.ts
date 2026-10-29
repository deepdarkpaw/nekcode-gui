import {
  ASYNC_ACTION_IDLE,
  reduceAsyncAction,
  type AsyncActionEvent,
  type AsyncActionState,
} from "@/lib/asyncAction.js";

export interface PlanReviewState {
  expanded: boolean;
  submit: AsyncActionState;
  closed: boolean;
  notice: "nek.interaction.cancelledByHost" | null;
}

export type PlanReviewEvent =
  | { type: "toggleBody" }
  | { type: "submit"; event: AsyncActionEvent }
  | { type: "close" }
  | { type: "hostCancel" };

export function planBodyDefaultOpen(markdown: string): boolean {
  return markdown.split("\n").length <= 40;
}

export function createPlanReviewState(markdown: string): PlanReviewState {
  return {
    expanded: planBodyDefaultOpen(markdown),
    submit: ASYNC_ACTION_IDLE,
    closed: false,
    notice: null,
  };
}

export function reducePlanReview(state: PlanReviewState, event: PlanReviewEvent): PlanReviewState {
  if (state.closed && event.type !== "hostCancel") return state;
  switch (event.type) {
    case "toggleBody":
      return { ...state, expanded: !state.expanded };
    case "submit": {
      const submit = reduceAsyncAction(state.submit, event.event);
      return submit === state.submit ? state : { ...state, submit };
    }
    case "close":
      return state.closed ? state : { ...state, closed: true };
    case "hostCancel":
      return state.notice && state.closed
        ? state
        : { ...state, closed: true, notice: "nek.interaction.cancelledByHost" };
  }
}
