import { isImeComposing } from "@/lib/imeComposition.js";

export type OnboardingKeyCommand = "back" | "next" | "close";

export interface OnboardingKeyInput {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  childDialogOpen: boolean;
  canBack: boolean;
  canNext: boolean;
  installing: boolean;
}

export function resolveOnboardingKey(input: OnboardingKeyInput): OnboardingKeyCommand | null {
  if (isImeComposing(input)) return null;
  if (input.altKey && input.key === "ArrowLeft") {
    return input.canBack && !input.installing ? "back" : null;
  }
  if (input.altKey && input.key === "ArrowRight") {
    return input.canNext && !input.installing ? "next" : null;
  }
  if (input.key === "Escape") {
    return !input.childDialogOpen && !input.installing ? "close" : null;
  }
  return null;
}
