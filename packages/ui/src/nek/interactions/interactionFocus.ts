import type { KeyboardShortcutPlatformInfo } from "@/lib/keyboardShortcuts.js";
import type { ShortcutBindingEvent } from "@/shortcuts/bindings.js";
import {
  matchActionEvent,
  resolveEffectiveActionBindings,
  type EffectiveActionBindings,
} from "@/shortcuts/actionRegistry.js";

export const INTERACTION_FOCUS_ACTION_ID = "gui.interaction.focus" as const;

/** Match the registered global action; no pending request means the shortcut is untouched. */
export function resolveInteractionFocusAction(
  event: ShortcutBindingEvent,
  hasPendingRequest: boolean,
  effective: EffectiveActionBindings = resolveEffectiveActionBindings(),
  platformInfo?: KeyboardShortcutPlatformInfo,
): "focus" | null {
  if (!hasPendingRequest) return null;
  return matchActionEvent(event, effective, "global", platformInfo) === INTERACTION_FOCUS_ACTION_ID
    ? "focus"
    : null;
}

/** The visual layer supplies the default-focus operation for the current queue head. */
export function focusInteractionQueue(
  hasPendingRequest: boolean,
  focusDefault: () => void,
): boolean {
  if (!hasPendingRequest) return false;
  focusDefault();
  return true;
}
