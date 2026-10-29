import { isImeComposing } from "@/lib/imeComposition.js";

export interface SelectState {
  filter: string;
  highlighted: number;
  closed: boolean;
  notice?: "nek.interaction.cancelledByHost" | "nek.interaction.timedOut";
}
export type SelectEvent =
  | { type: "setFilter"; value: string; itemCount: number }
  | { type: "move"; delta: 1 | -1; itemCount: number }
  | { type: "highlight"; index: number; itemCount: number }
  | { type: "close"; notice?: SelectState["notice"] };

export interface ConfirmState {
  closed: boolean;
  notice?: "nek.interaction.cancelledByHost" | "nek.interaction.timedOut";
}
export interface InputState {
  text: string;
  closed: boolean;
  notice?: "nek.interaction.cancelledByHost" | "nek.interaction.timedOut";
}
export interface EditorState {
  text: string;
  prefill: string;
  confirmDiscard: boolean;
  closed: boolean;
  notice?:
    | "nek.interaction.cancelledByHost"
    | "nek.interaction.timedOut"
    | "nek.interaction.timedOutDiscarded";
}

export type DialogKeyTarget = "filter" | "input" | "editor" | "card" | "button";

function wrapIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  return (current + delta + count) % count;
}

export function filterSelectOptions(
  options: readonly string[],
  filter: string,
): Array<{ value: string; index: number }> {
  const normalized = filter.toLocaleLowerCase();
  return options.reduce<Array<{ value: string; index: number }>>((items, value, index) => {
    if (value.toLocaleLowerCase().includes(normalized)) items.push({ value, index });
    return items;
  }, []);
}

export function createSelectState(): SelectState {
  return { filter: "", highlighted: 0, closed: false };
}
export function createConfirmState(): ConfirmState {
  return { closed: false };
}
export function createInputState(): InputState {
  return { text: "", closed: false };
}
export function createEditorState(prefill = ""): EditorState {
  return { text: prefill, prefill, confirmDiscard: false, closed: false };
}

export function reduceSelect(state: SelectState, event: SelectEvent): SelectState {
  if (state.closed) return state;
  switch (event.type) {
    case "setFilter":
      return { ...state, filter: event.value, highlighted: event.itemCount > 0 ? 0 : -1 };
    case "move":
      return {
        ...state,
        highlighted: wrapIndex(
          state.highlighted < 0 ? 0 : state.highlighted,
          event.delta,
          event.itemCount,
        ),
      };
    case "highlight":
      return event.index >= 0 && event.index < event.itemCount
        ? { ...state, highlighted: event.index }
        : state;
    case "close":
      return { ...state, closed: true, ...(event.notice ? { notice: event.notice } : {}) };
  }
}

export function reduceConfirm(
  state: ConfirmState,
  event: { type: "close"; notice?: ConfirmState["notice"] },
): ConfirmState {
  if (state.closed) return state;
  return { ...state, closed: true, ...(event.notice ? { notice: event.notice } : {}) };
}

export function reduceInput(
  state: InputState,
  event: { type: "setText"; text: string } | { type: "close"; notice?: InputState["notice"] },
): InputState {
  if (state.closed) return state;
  if (event.type === "setText") return { ...state, text: event.text };
  return { ...state, closed: true, ...(event.notice ? { notice: event.notice } : {}) };
}

export function reduceEditor(
  state: EditorState,
  event:
    | { type: "setText"; text: string }
    | { type: "requestCancel" }
    | { type: "keepEditing" }
    | { type: "discard"; notice?: EditorState["notice"] }
    | { type: "close"; notice?: EditorState["notice"] },
): EditorState {
  if (state.closed) return state;
  switch (event.type) {
    case "setText":
      return { ...state, text: event.text };
    case "requestCancel":
      return state.text !== state.prefill
        ? { ...state, confirmDiscard: true }
        : { ...state, closed: true };
    case "keepEditing":
      return { ...state, confirmDiscard: false };
    case "discard":
    case "close":
      return {
        ...state,
        closed: true,
        confirmDiscard: false,
        ...(event.notice ? { notice: event.notice } : {}),
      };
  }
}

export function resolveSelectKey(input: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget: DialogKeyTarget;
  filter: string;
  highlighted: number;
}): "next" | "previous" | "select" | "clearFilter" | "cancel" | "noop" | null {
  if (isImeComposing(input) || input.focusTarget !== "filter") return null;
  if (input.key === "ArrowDown") return "next";
  if (input.key === "ArrowUp") return "previous";
  if (input.key === "Enter") return input.highlighted >= 0 ? "select" : "noop";
  if (input.key === "Escape") return input.filter ? "clearFilter" : "cancel";
  return null;
}

export function resolveConfirmKey(input: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget: DialogKeyTarget;
}): "cancel" | null {
  if (isImeComposing(input) || input.focusTarget === "button") return null;
  return input.key === "Escape" ? "cancel" : null;
}

export function resolveInputKey(input: {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget: DialogKeyTarget;
}): "submit" | "cancel" | null {
  if (isImeComposing(input) || input.focusTarget !== "input") return null;
  if (input.key === "Enter") return "submit";
  if (input.key === "Escape") return "cancel";
  return null;
}

export function resolveEditorKey(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget: DialogKeyTarget;
  confirmDiscard: boolean;
}): "submit" | "cancel" | "keepEditing" | null {
  if (isImeComposing(input) || input.focusTarget === "button") return null;
  if (
    input.key === "Escape" &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.shiftKey &&
    !input.altKey
  ) {
    return input.confirmDiscard ? "keepEditing" : "cancel";
  }
  if (
    input.key === "Enter" &&
    (input.ctrlKey || input.metaKey) &&
    !input.shiftKey &&
    !input.altKey
  ) {
    return "submit";
  }
  return null;
}
