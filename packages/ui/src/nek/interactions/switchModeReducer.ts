import {
  ASYNC_ACTION_IDLE,
  reduceAsyncAction,
  type AsyncActionEvent,
  type AsyncActionState,
} from "@/lib/asyncAction.js";

export interface SwitchModeState {
  submit: AsyncActionState;
  closed: boolean;
  notice: "nek.interaction.cancelledByHost" | null;
}

export type SwitchModeEvent =
  | { type: "submit"; event: AsyncActionEvent }
  | { type: "close" }
  | { type: "hostCancel" };

export function createSwitchModeState(): SwitchModeState {
  return { submit: ASYNC_ACTION_IDLE, closed: false, notice: null };
}

export function reduceSwitchMode(state: SwitchModeState, event: SwitchModeEvent): SwitchModeState {
  if (state.closed && event.type !== "hostCancel") return state;
  switch (event.type) {
    case "submit": {
      const submit = reduceAsyncAction(state.submit, event.event);
      return submit === state.submit ? state : { ...state, submit };
    }
    case "close":
      return state.closed ? state : { ...state, closed: true };
    case "hostCancel":
      return state.closed && state.notice
        ? state
        : { ...state, closed: true, notice: "nek.interaction.cancelledByHost" };
  }
}
