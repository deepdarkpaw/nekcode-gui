import { isImeComposing } from "@/lib/imeComposition.js";

export type AskQuestionFocusTarget = "card" | "option" | "other" | "button";

export interface AskQuestionKeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget: AskQuestionFocusTarget;
  active: number;
  optionCount: number;
  allowMultiple: boolean;
  questionIndex: number;
  canSubmit: boolean;
  otherValue: string;
  caretOnFirstLine?: boolean;
  caretOnLastLine?: boolean;
}

export type AskQuestionKeyCommand =
  | { type: "setActive"; active: number }
  | { type: "selectOption"; index: number; submit: boolean }
  | { type: "previous" }
  | { type: "dismiss" }
  | { type: "primary" }
  | { type: "noop" };

function hasModifier(input: AskQuestionKeyInput): boolean {
  return Boolean(input.shiftKey || input.ctrlKey || input.metaKey || input.altKey);
}

function escaped(input: AskQuestionKeyInput): AskQuestionKeyCommand {
  return input.questionIndex > 0 ? { type: "previous" } : { type: "dismiss" };
}

function optionCommand(input: AskQuestionKeyInput, index: number): AskQuestionKeyCommand {
  return {
    type: "selectOption",
    index,
    submit: !input.allowMultiple,
  };
}

function digitCommand(input: AskQuestionKeyInput): AskQuestionKeyCommand | null {
  if (hasModifier(input) || !/^[1-9]$/u.test(input.key)) return null;
  const index = Number(input.key) - 1;
  return index < input.optionCount ? optionCommand(input, index) : null;
}

/** Pure AQ keyboard table. Null means the browser/input keeps the key. */
export function resolveAskQuestionKey(input: AskQuestionKeyInput): AskQuestionKeyCommand | null {
  if (isImeComposing(input)) return null;
  if (input.focusTarget === "button") return null;
  const digit = digitCommand(input);
  if (digit && input.focusTarget !== "other") return digit;

  if (input.focusTarget === "card") {
    if (hasModifier(input)) return null;
    if (input.key === "ArrowDown") return { type: "setActive", active: 0 };
    if (input.key === "ArrowUp") return { type: "setActive", active: input.optionCount };
    if (input.key === "Enter") return input.canSubmit ? { type: "primary" } : { type: "noop" };
    if (input.key === "Escape") return escaped(input);
    return null;
  }

  if (input.focusTarget === "option") {
    if (input.key === "ArrowDown" || input.key === "ArrowRight") {
      if (hasModifier(input)) return null;
      return { type: "setActive", active: (input.active + 1) % (input.optionCount + 1) };
    }
    if (input.key === "ArrowUp" || input.key === "ArrowLeft") {
      if (hasModifier(input)) return null;
      return {
        type: "setActive",
        active: (input.active - 1 + input.optionCount + 1) % (input.optionCount + 1),
      };
    }
    if (input.key === "Home") return hasModifier(input) ? null : { type: "setActive", active: 0 };
    if (input.key === "End") {
      return hasModifier(input) ? null : { type: "setActive", active: input.optionCount };
    }
    if (input.key === "Escape" && !hasModifier(input)) return escaped(input);
    if ((input.key === " " || input.key === "Spacebar") && !hasModifier(input)) {
      return optionCommand(input, input.active);
    }
    if (input.key === "Enter" && !hasModifier(input)) {
      if (!input.allowMultiple) return optionCommand(input, input.active);
      return input.canSubmit ? { type: "primary" } : optionCommand(input, input.active);
    }
    return null;
  }

  if (input.focusTarget === "other") {
    if (input.key === "Enter") {
      if (input.shiftKey && !input.ctrlKey && !input.metaKey && !input.altKey) return null;
      if (input.ctrlKey || input.metaKey || !hasModifier(input)) {
        return input.canSubmit ? { type: "primary" } : { type: "noop" };
      }
      return null;
    }
    if (input.key === "ArrowUp" && !hasModifier(input) && input.caretOnFirstLine) {
      return { type: "setActive", active: input.optionCount - 1 };
    }
    if (input.key === "ArrowDown" && !hasModifier(input) && input.caretOnLastLine) {
      return { type: "setActive", active: 0 };
    }
    if (input.key === "Escape" && !hasModifier(input)) {
      return input.otherValue.length > 0 ? { type: "setActive", active: -1 } : escaped(input);
    }
  }
  return null;
}

export function getAskQuestionOptionTabIndex(active: number, optionIndex: number): 0 | -1 {
  return (active < 0 ? optionIndex === 0 : active === optionIndex) ? 0 : -1;
}

export interface CaretLinePosition {
  onFirstLine: boolean;
  onLastLine: boolean;
}

/** Calculate hard-newline position without measuring soft-wrapped lines. */
export function caretLinePosition(textarea: {
  value: string;
  selectionStart: number | null;
}): CaretLinePosition {
  const caret = Math.max(0, Math.min(textarea.selectionStart ?? 0, textarea.value.length));
  const before = textarea.value.slice(0, caret);
  const after = textarea.value.slice(caret);
  return {
    onFirstLine: !before.includes("\n"),
    onLastLine: !after.includes("\n"),
  };
}
