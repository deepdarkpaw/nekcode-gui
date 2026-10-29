import { isImeComposing } from "@/lib/imeComposition.js";

export type SwitchModeFocusTarget = "card" | "button";

export function resolveSwitchModeKey(input: {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget: SwitchModeFocusTarget;
}): "reject" | null {
  if (isImeComposing(input) || input.focusTarget === "button") return null;
  if (
    input.key === "Escape" &&
    !input.shiftKey &&
    !input.ctrlKey &&
    !input.metaKey &&
    !input.altKey
  ) {
    return "reject";
  }
  return null;
}
