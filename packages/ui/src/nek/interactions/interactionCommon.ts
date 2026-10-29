import { useCallback, useEffect, useRef, useState } from "react";
import type { AsyncActionState } from "@/lib/asyncAction.js";

export interface ActionHandle {
  visible: boolean;
  enabled: boolean;
  disabledReason?: { id: string; values?: Record<string, string | number> };
  pending: boolean;
  error?: string;
  primary?: boolean;
  destructive?: boolean;
  shortcutActionId?: string;
  run: () => Promise<void>;
}

export type InteractionFocusId = string;

export interface ActiveElementInfo {
  isEditable: boolean;
  hasContent: boolean;
  hasSelection: boolean;
}

/** New interaction cards do not steal meaningful user input or a text selection. */
export function shouldTakeFocus(active: ActiveElementInfo | undefined): boolean {
  if (!active) return true;
  if (!active.isEditable) return true;
  return !active.hasContent && !active.hasSelection;
}

export interface InteractionFocusHandle {
  target: InteractionFocusId | null;
  ref: (id: InteractionFocusId) => (element: HTMLElement | null) => void;
  setTarget: (target: InteractionFocusId | null) => void;
}

export interface InteractionFocusOptions {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

/** Focus registry used by headless controllers; the visual layer only registers elements. */
export function useInteractionFocus(options: InteractionFocusOptions = {}): InteractionFocusHandle {
  const [target, setTarget] = useState<InteractionFocusId | null>(null);
  const elementsRef = useRef(new Map<InteractionFocusId, HTMLElement>());
  const frameRef = useRef<number | null>(null);
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));

  const ref = useCallback((id: InteractionFocusId) => {
    return (element: HTMLElement | null) => {
      if (element) elementsRef.current.set(id, element);
      else elementsRef.current.delete(id);
    };
  }, []);

  useEffect(() => {
    if (frameRef.current !== null) cancelFrame(frameRef.current);
    if (target === null) {
      frameRef.current = null;
      return;
    }
    frameRef.current = requestFrame(() => {
      frameRef.current = null;
      const element = elementsRef.current.get(target);
      if (element && !element.hasAttribute("disabled")) element.focus();
    });
    return () => {
      if (frameRef.current !== null) cancelFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [cancelFrame, requestFrame, target]);

  return { target, ref, setTarget };
}

export function asyncActionView(state: AsyncActionState): {
  pending: boolean;
  error?: string;
} {
  return {
    pending: state.status === "pending",
    ...(state.status === "error" ? { error: state.message } : {}),
  };
}

export function disabledReason(pending: boolean, reasonId: string): { id: string } | undefined {
  return pending ? { id: reasonId } : undefined;
}
