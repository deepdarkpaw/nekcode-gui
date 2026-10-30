import { useEffect, useRef } from "react";
import type { KeyboardShortcutPlatformInfo } from "@/lib/keyboardShortcuts.js";
import {
  isEditableShortcutEventTarget,
  isShortcutRecordingActive,
  type ShortcutBindingEvent,
} from "./bindings.js";
import {
  matchActionEvent,
  resolveEffectiveActionBindings,
  type EffectiveActionBindings,
} from "./actionRegistry.js";
import { getActionShortcutOverrides } from "./useActionShortcuts.js";
import { getNekAction, type NekActionId } from "./nekActions.js";

export interface NekActionHandler {
  readonly enabled?: boolean;
  readonly disabledReason?: { id: string; values?: Record<string, string | number> };
  readonly run: () => void;
}

export type NekActionHandlers = Partial<Record<NekActionId, NekActionHandler | null>>;

interface HandlerRegistration {
  readonly handlers: NekActionHandlers;
  readonly priority: number;
}

const registrations = new Map<string, HandlerRegistration>();
let nextOwnerId = 0;

/**
 * 仅在键盘事件由聚焦可编辑控件发出时使用的动作判定。
 * IME、repeat、长按等噪声由 shortcuts 内核统一过滤。
 */
export function resolveNekActionKeyboardEvent(
  event: ShortcutBindingEvent,
  effective: EffectiveActionBindings = resolveEffectiveActionBindings(),
  editableTarget = false,
  platformInfo?: KeyboardShortcutPlatformInfo,
): NekActionId | null {
  const actionId = matchActionEvent(event, effective, "global", platformInfo);
  if (actionId === null) return null;
  if (editableTarget && !getNekAction(actionId).allowInEditable) return null;
  return actionId;
}

/** 注册一个 pane/app 的当前动作处理器；cleanup 后不会残留旧 pane 的回调。 */
export function registerNekActionHandlers(
  handlers: NekActionHandlers,
  priority = 0,
): () => void {
  const ownerId = `nek-action-owner-${nextOwnerId++}`;
  registrations.set(ownerId, { handlers, priority });
  return () => {
    registrations.delete(ownerId);
  };
}

function currentHandler(actionId: NekActionId): NekActionHandler | null {
  const candidates = [...registrations.values()]
    .map((registration) => ({
      handler: registration.handlers[actionId],
      priority: registration.priority,
    }))
    .filter(
      (candidate): candidate is { handler: NekActionHandler; priority: number } =>
        candidate.handler !== null && candidate.handler !== undefined,
    )
    .sort((left, right) => right.priority - left.priority);
  return candidates[0]?.handler ?? null;
}

/** 只对已注册且 enabled 的动作返回 true；未接线动作不会吞掉浏览器默认行为。 */
export function dispatchNekAction(actionId: NekActionId): boolean {
  const handler = currentHandler(actionId);
  if (!handler || handler.enabled === false) return false;
  handler.run();
  return true;
}

/** 在宿主组件中挂载唯一的 window capture 键盘通道。 */
export function useNekActionKeyboard(
  platformInfo?: KeyboardShortcutPlatformInfo,
): void {
  const platformInfoRef = useRef(platformInfo);
  platformInfoRef.current = platformInfo;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || isShortcutRecordingActive()) return;
      const actionId = resolveNekActionKeyboardEvent(
        event,
        resolveEffectiveActionBindings(getActionShortcutOverrides()),
        isEditableShortcutEventTarget(event.target),
        platformInfoRef.current,
      );
      if (actionId === null || !dispatchNekAction(actionId)) return;
      event.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);
}

/** React pane/app 注册桥；enabled=false 时仍可暴露 disabledReason 供调试/测试。 */
export function useNekActionHandlers(
  handlers: NekActionHandlers,
  enabled = true,
  priority = 0,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    return registerNekActionHandlers(handlersRef.current, priority);
  }, [enabled, priority]);
}

export function resetNekActionHandlersForTest(): void {
  registrations.clear();
  nextOwnerId = 0;
}
