/**
 * 对话框关闭后焦点回到打开它的元素（交互规范 §7.3）。
 *
 * Radix 只在使用 `DialogTrigger` 打开时才会自动还原焦点；由菜单项、快捷键、
 * 命令面板等程序化打开的对话框需要这个 hook：
 *
 * ```tsx
 * const focusRestore = useFocusRestore(open);
 * <DialogContent onCloseAutoFocus={focusRestore.onCloseAutoFocus}>…</DialogContent>
 * ```
 *
 * 非 Radix 浮层在关闭时调用 `focusRestore.restoreFocus()`。
 */
import { useCallback, useRef } from "react";

export interface FocusRestoreHandle {
  /** 传给 Radix `onCloseAutoFocus`：还原到打开前的焦点元素。 */
  onCloseAutoFocus: (event: Event) => void;
  /** 手动还原焦点；成功返回 true。 */
  restoreFocus: () => boolean;
}

function readActiveElement(): HTMLElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

/** 可以把焦点还给它：仍在文档中且未禁用。 */
export function canRestoreFocusTo(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected) {
    return false;
  }
  return !("disabled" in element && (element as HTMLButtonElement).disabled);
}

export function useFocusRestore(open: boolean): FocusRestoreHandle {
  const previousOpenRef = useRef(false);
  const returnTargetRef = useRef<HTMLElement | null>(null);

  // 必须在渲染阶段捕获：子组件（Radix FocusScope）的 effect 先于本组件执行，
  // 到 effect 时焦点已经被移进对话框。渲染阶段读取 activeElement 是幂等的。
  if (open && !previousOpenRef.current) {
    returnTargetRef.current = readActiveElement();
  }
  previousOpenRef.current = open;

  const restoreFocus = useCallback((): boolean => {
    const target = returnTargetRef.current;
    returnTargetRef.current = null;
    if (!canRestoreFocusTo(target)) {
      return false;
    }
    target.focus({ preventScroll: true });
    return true;
  }, []);

  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      // 目标已不在文档中时保留 Radix 默认行为，不静默吞掉焦点。
      if (canRestoreFocusTo(returnTargetRef.current)) {
        event.preventDefault();
        restoreFocus();
      }
    },
    [restoreFocus],
  );

  return { onCloseAutoFocus, restoreFocus };
}
