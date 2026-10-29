import { useCallback, useEffect, useRef, useState } from "react";
import type { AsyncActionState } from "@/lib/asyncAction.js";

export interface RemoteMessage {
  id: string;
  values?: Record<string, string | number>;
}

export interface RemoteActionHandle {
  /** Message id for the action label; visual layers do not hard-code button copy. */
  label?: RemoteMessage;
  visible: boolean;
  enabled: boolean;
  disabledReason?: RemoteMessage;
  pending: boolean;
  error?: string;
  primary?: boolean;
  destructive?: boolean;
  shortcutActionId?: string;
  run: () => Promise<void>;
}

export type RemoteActionId = string;

export interface ActiveElementInfo {
  kind: "input" | "textarea" | "contenteditable" | "other";
  hasContent: boolean;
  hasSelection: boolean;
}

/** Whether a newly-arrived blocking interaction may move focus into itself. */
export function shouldTakeFocus(activeElement: ActiveElementInfo | undefined): boolean {
  if (!activeElement) return true;
  const isEditable =
    activeElement.kind === "input" ||
    activeElement.kind === "textarea" ||
    activeElement.kind === "contenteditable";
  return !(isEditable && (activeElement.hasContent || activeElement.hasSelection));
}

export interface RemoteFocusController<T extends string = string> {
  target: T | null;
  ref: (id: T) => (element: HTMLElement | null) => void;
}

/** Registers visual elements while keeping focus policy in the headless layer. */
export function useRemoteInteractionFocus<T extends string = string>(
  open: boolean,
  initialTarget: T,
  activeElement: ActiveElementInfo | undefined,
  focusToken: string,
): RemoteFocusController<T> & { attention: boolean } {
  const [target, setTarget] = useState<T | null>(() =>
    open && shouldTakeFocus(activeElement) ? initialTarget : null,
  );
  const elementsRef = useRef(new Map<T, HTMLElement>());
  const shouldFocus = open && shouldTakeFocus(activeElement);

  useEffect(() => {
    setTarget(shouldFocus ? initialTarget : null);
  }, [focusToken, initialTarget, shouldFocus]);

  useEffect(() => {
    if (!target || typeof requestAnimationFrame !== "function") return;
    const frame = requestAnimationFrame(() => {
      const element = elementsRef.current.get(target);
      if (!element || !element.isConnected || element.hasAttribute("disabled")) return;
      element.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  const ref = useCallback(
    (id: T) => (element: HTMLElement | null) => {
      if (element) {
        elementsRef.current.set(id, element);
      } else {
        elementsRef.current.delete(id);
      }
    },
    [],
  );

  return { target, ref, attention: open && !shouldFocus };
}

export function actionError(state: AsyncActionState): string | undefined {
  return state.status === "error" ? state.message : undefined;
}

export function actionPending(state: AsyncActionState): boolean {
  return state.status === "pending";
}

export function disabledReasonForBusy(busy: boolean): RemoteMessage | undefined {
  return busy ? { id: "ui.action.busy" } : undefined;
}

export function createActionRunner(
  action: { run: () => Promise<boolean> },
  onRun?: () => void,
): () => Promise<void> {
  return async () => {
    onRun?.();
    await action.run();
  };
}
