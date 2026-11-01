import { parseShortcutBinding } from "@zcode/shared";
import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "../lib/keyboardShortcuts.js";

/** Physical equality follows the shortcut matcher's platform modifier semantics. */
function canonicalBindingKey(binding: string, isApple: boolean): string | null {
  const parsed = parseShortcutBinding(binding);
  if (parsed === null) return null;
  if (isApple) {
    return `${parsed.cmdOrCtrl || parsed.altGr ? 1 : 0}${parsed.ctrl ? 1 : 0}${
      parsed.alt || parsed.altGr ? 1 : 0
    }${parsed.shift ? 1 : 0}:${parsed.key}`;
  }
  return `${parsed.cmdOrCtrl || parsed.ctrl || parsed.altGr ? 1 : 0}${
    parsed.alt || parsed.altGr ? 1 : 0
  }${parsed.shift ? 1 : 0}:${parsed.key}`;
}

/** Shared by nek action conflict detection; invalid bindings are never equal. */
export function isSamePhysicalBinding(
  a: string,
  b: string,
  options?: { platformInfo?: KeyboardShortcutPlatformInfo },
): boolean {
  const isApple = isAppleKeyboardPlatform(options?.platformInfo);
  const keyA = canonicalBindingKey(a, isApple);
  const keyB = canonicalBindingKey(b, isApple);
  return keyA !== null && keyA === keyB;
}
