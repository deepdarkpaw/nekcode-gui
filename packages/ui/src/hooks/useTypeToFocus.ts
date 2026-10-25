/**
 * 焦点不在可编辑元素时，直接打字会聚焦目标输入框并插入该字符（交互规范 §7.3）。
 *
 * 实现要点：在 keydown 阶段把焦点移到目标且**不** preventDefault——Chromium 会把这次按键
 * 产生的文字输入投递给新的焦点元素，因此 React 受控输入框与 Lexical 编辑器都能正常收到字符，
 * 不需要手动改写值。IME 组字、带 Ctrl/Meta/Alt 的组合键、菜单/列表/对话框内的按键一律放行。
 *
 * ```tsx
 * const inputRef = useRef<HTMLTextAreaElement>(null);
 * useTypeToFocus(inputRef, { enabled: !isMobile });
 * ```
 */
import { useEffect, useRef, type RefObject } from "react";
import {
  canReceiveTypedText,
  focusAtEnd,
  readTypeToFocusContext,
  shouldTypeToFocus,
} from "@/lib/typeToFocus.js";

export interface UseTypeToFocusOptions {
  enabled?: boolean;
  /** 自定义聚焦方式（如 Lexical 的 `editor.focus()`）；默认聚焦并把光标放到末尾。 */
  focus?: (target: HTMLElement) => void;
}

export function useTypeToFocus(
  targetRef: RefObject<HTMLElement | null>,
  options: UseTypeToFocusOptions = {},
): void {
  const { enabled = true } = options;
  const focusRef = useRef(options.focus);
  focusRef.current = options.focus;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      const context = readTypeToFocusContext(document.activeElement);
      if (!shouldTypeToFocus(event, context)) {
        return;
      }
      const target = targetRef.current;
      if (!target || !canReceiveTypedText(target)) {
        return;
      }
      (focusRef.current ?? focusAtEnd)(target);
    };
    // 冒泡阶段监听：组件自己的按键处理（含 preventDefault）优先。
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, targetRef]);
}
