/**
 * 撤销 toast（交互规范 §7.2）：可撤销的删除（单个模型、单个 MCP 服务器等）弹 5 秒撤销提示。
 *
 * 推荐模式：先执行删除，onUndo 恢复；需要延迟真正落盘时用 onExpire（超时且未撤销才调用）。
 *
 * ```tsx
 * const showUndo = useUndoToast();
 * showUndo({ message: intl.formatMessage({ id: "…" }), onUndo: () => restoreModel(model) });
 * ```
 */
import { useCallback } from "react";
import { dismissToast, toast } from "./toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export const UNDO_TOAST_DURATION_MS = 5000;

export interface UndoToastOptions {
  message: string;
  onUndo: () => void;
  durationMs?: number;
  /** 超时且未撤销时调用（延迟落盘场景）。 */
  onExpire?: () => void;
}

export interface UndoToastLabels {
  undoLabel: string;
  dismissLabel: string;
}

/** 撤销/过期只会发生其一，且各最多一次。 */
export function createUndoGate(onUndo: () => void, onExpire?: () => void) {
  let settled = false;
  return {
    undo(): boolean {
      if (settled) return false;
      settled = true;
      onUndo();
      return true;
    },
    expire(): boolean {
      if (settled) return false;
      settled = true;
      onExpire?.();
      return true;
    },
  };
}

/** 弹出撤销 toast，返回 toast id。文案需已本地化（React 内请用 useUndoToast）。 */
export function showUndoToast(
  { message, onUndo, durationMs = UNDO_TOAST_DURATION_MS, onExpire }: UndoToastOptions,
  { undoLabel, dismissLabel }: UndoToastLabels,
): number {
  const gate = createUndoGate(onUndo, onExpire);
  const id = toast(message, {
    durationMs,
    position: "bottom-center",
    variant: "info",
    actionLabel: undoLabel,
    onAction: () => {
      gate.undo();
    },
    dismissible: true,
    dismissLabel,
  });
  setTimeout(() => {
    if (gate.expire()) {
      dismissToast(id);
    }
  }, durationMs);
  return id;
}

/** React 入口：自动填充本地化的「撤销」「关闭」文案。 */
export function useUndoToast(): (options: UndoToastOptions) => number {
  const { intl } = useZCodeIntl();
  return useCallback(
    (options: UndoToastOptions) =>
      showUndoToast(options, {
        undoLabel: intl.formatMessage({ id: "ui.undoToast.undo" }),
        dismissLabel: intl.formatMessage({ id: "common.close" }),
      }),
    [intl],
  );
}
