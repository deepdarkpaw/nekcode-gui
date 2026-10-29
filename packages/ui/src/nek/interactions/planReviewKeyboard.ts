import { isImeComposing } from "@/lib/imeComposition.js";

export type PlanReviewFocusTarget = "card" | "button" | "multiline";
export type PlanReviewKeyCommand = "implement" | "later";

export function resolvePlanReviewKey(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget: PlanReviewFocusTarget;
}): PlanReviewKeyCommand | null {
  if (
    isImeComposing(input) ||
    input.focusTarget === "button" ||
    input.focusTarget === "multiline"
  ) {
    return null;
  }
  if (
    input.key === "Escape" &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.shiftKey &&
    !input.altKey
  ) {
    return "later";
  }
  if (
    input.key === "Enter" &&
    (input.ctrlKey || input.metaKey) &&
    !input.shiftKey &&
    !input.altKey
  ) {
    return "implement";
  }
  return null;
}
