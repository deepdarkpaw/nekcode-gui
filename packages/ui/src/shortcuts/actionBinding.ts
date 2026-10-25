/**
 * 动作绑定串扩展层：在现有内核（shared/shortcutCommands 的序列化格式 + bindings.ts 匹配器 +
 * label.ts 格式化 + conflicts.ts 物理等价归一）之上补充 Escape / Tab / Space / Backspace 四个键。
 *
 * 这些键在全局命令表里被刻意排除（它们是组件固定交互），但 nek 动作（Esc 停止、Shift+Tab
 * 循环思考等级）需要它们。扩展方式是「代位键」：把扩展键替换成 F1 交给内核处理修饰键语义，
 * 再单独比较真实键名——修饰键规则只有内核一份，不复制。
 */
import { parseShortcutBinding, type ParsedShortcutBinding } from "@zcode/shared";
import {
  isAppleKeyboardPlatform,
  type KeyboardShortcutPlatformInfo,
} from "@/lib/keyboardShortcuts.js";
import { matchesShortcutBinding, type ShortcutBindingEvent } from "./bindings.js";
import { isSamePhysicalBinding } from "./conflicts.js";
import { formatShortcutBindingLabelParts } from "./label.js";

/** 扩展键名（规范形式）。 */
const EXTRA_KEYS: ReadonlySet<string> = new Set(["Escape", "Tab", "Space", "Backspace"]);

/** 代位键：内核白名单内、且不会与扩展键混淆的命名键。 */
const SURROGATE_KEY = "F1";

/** 扩展键对应的 KeyboardEvent.key。 */
const EXTRA_KEY_EVENT_KEYS: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Tab: "Tab",
  Space: " ",
  Backspace: "Backspace",
};

interface SplitBinding {
  /** 键名替换为代位键后的绑定串（只用于修饰键比较）。 */
  surrogate: string;
  key: string;
}

function splitBinding(binding: string): SplitBinding | null {
  const tokens = binding.split("+");
  const key = tokens[tokens.length - 1];
  if (key === undefined || key === "") {
    return null;
  }
  const surrogate = [...tokens.slice(0, -1), SURROGATE_KEY].join("+");
  const parsed = parseShortcutBinding(EXTRA_KEYS.has(key) ? surrogate : binding);
  if (parsed === null) {
    return null;
  }
  return { surrogate, key: EXTRA_KEYS.has(key) ? key : parsed.key };
}

/** 解析动作绑定串（内核格式 + 扩展键）；非法返回 null。 */
export function parseActionBinding(binding: string): ParsedShortcutBinding | null {
  const split = splitBinding(binding);
  if (split === null) {
    return null;
  }
  const parsed = parseShortcutBinding(split.surrogate);
  return parsed === null ? null : { ...parsed, key: split.key };
}

/** 绑定串是否合法。 */
export function isValidActionBinding(binding: string): boolean {
  return parseActionBinding(binding) !== null;
}

/** 键盘事件是否命中动作绑定（IME 组字 / 长按 repeat 由内核过滤）。 */
export function matchesActionBinding(
  event: ShortcutBindingEvent,
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  const split = splitBinding(binding);
  if (split === null) {
    return false;
  }
  if (!EXTRA_KEYS.has(split.key)) {
    return matchesShortcutBinding(event, binding, platformInfo);
  }
  if (event.key !== EXTRA_KEY_EVENT_KEYS[split.key]) {
    return false;
  }
  const surrogateEvent = { ...event, key: SURROGATE_KEY, code: SURROGATE_KEY };
  return matchesShortcutBinding(surrogateEvent, split.surrogate, platformInfo);
}

/** 两个动作绑定是否为同一物理组合（平台等价归一沿用 conflicts.ts）。 */
export function isSameActionBinding(
  a: string,
  b: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): boolean {
  const splitA = splitBinding(a);
  const splitB = splitBinding(b);
  if (splitA === null || splitB === null || splitA.key !== splitB.key) {
    return false;
  }
  return isSamePhysicalBinding(splitA.surrogate, splitB.surrogate, { platformInfo });
}

const APPLE_KEY_LABELS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Tab: "⇥",
  Space: "Space",
  Backspace: "⌫",
  Enter: "↩",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const DEFAULT_KEY_LABELS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Enter: "Enter",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** 绑定串 → 逐键 token（键帽渲染用）：macOS `["⌥","↩"]`，Windows/Linux `["Alt","Enter"]`。 */
export function formatActionBindingLabelParts(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string[] {
  const split = splitBinding(binding);
  if (split === null) {
    return [binding];
  }
  const parts = formatShortcutBindingLabelParts(split.surrogate, platformInfo);
  const labels = isAppleKeyboardPlatform(platformInfo) ? APPLE_KEY_LABELS : DEFAULT_KEY_LABELS;
  const keyLabel =
    labels[split.key] ?? formatShortcutBindingLabelParts(binding, platformInfo).at(-1) ?? split.key;
  return [...parts.slice(0, -1), keyLabel];
}

/** 绑定串 → 平台展示 label（macOS 空格分隔符号，Windows/Linux 用 `+` 连接）。 */
export function formatActionBindingLabel(
  binding: string,
  platformInfo?: KeyboardShortcutPlatformInfo,
): string {
  return formatActionBindingLabelParts(binding, platformInfo).join(
    isAppleKeyboardPlatform(platformInfo) ? " " : "+",
  );
}
