/**
 * 快捷键录制：键盘事件 → 动作绑定串。
 *
 * 普通键交给现有内核录制器（shortcuts/bindings.ts recordShortcutBinding）；
 * 动作层扩展键（Tab / Space / Backspace）在这里补上修饰键序列化。
 * Escape 在录制态用于取消，不录制。
 */
import { recordShortcutBinding, type ShortcutBindingEvent } from "@/shortcuts/bindings.js";
import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";

export type ActionRecordResult =
  | { kind: "pending" }
  | { kind: "cancel" }
  | { kind: "invalid" }
  | { kind: "recorded"; binding: string };

const EXTRA_KEYS: Readonly<Record<string, string>> = {
  Tab: "Tab",
  " ": "Space",
  Backspace: "Backspace",
};

function modifierTokens(
  event: ShortcutBindingEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string[] {
  const apple = isAppleKeyboardPlatform(platformInfo);
  const tokens: string[] = [];
  if (apple ? event.metaKey : event.ctrlKey) {
    tokens.push("CmdOrCtrl");
  }
  if (apple && event.ctrlKey) {
    tokens.push("Ctrl");
  }
  if (event.altKey) {
    tokens.push("Alt");
  }
  if (event.shiftKey) {
    tokens.push("Shift");
  }
  return tokens;
}

export function recordActionBinding(
  event: ShortcutBindingEvent,
  platformInfo?: KeyboardShortcutPlatformInfo,
): ActionRecordResult {
  if (event.key === "Escape") {
    return { kind: "cancel" };
  }
  const extra = EXTRA_KEYS[event.key];
  if (extra !== undefined) {
    if (event.repeat === true) {
      return { kind: "pending" };
    }
    return { kind: "recorded", binding: [...modifierTokens(event, platformInfo), extra].join("+") };
  }
  const result = recordShortcutBinding(event, platformInfo);
  if (result.kind === "pending") {
    return { kind: "pending" };
  }
  return result.kind === "binding"
    ? { kind: "recorded", binding: result.binding }
    : { kind: "invalid" };
}
