/**
 * nek 动作键盘派发器（交互规范 §7.7）。
 *
 * 通道分层语义（对应 `.nek/specs/ui-logic/00-common.md` §3「Esc 只关最内层」）：
 * - capture：全局动作在 window capture 阶段先于浏览器默认行为执行（Ctrl+O/Ctrl+F 等），
 *   输入法、长按 repeat、录制态与 `allowInEditable=false` 的动作在可编辑元素内让路；
 * - bubble：`dispatchPhase: "bubble"` 的全局动作（Esc 停止生成）与全部 composer 动作在
 *   window bubble 阶段执行，内层组件（Lexical mention/slash 面板、Radix 对话框）已经拿到
 *   事件并 preventDefault 时直接让路，保证「只关最内层」。
 */
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
import {
  getNekAction,
  type NekActionDispatchPhase,
  type NekActionId,
} from "./nekActions.js";

export type { NekActionDispatchPhase };

export interface NekActionDispatchContext {
  /** 键盘来源的 DOM 事件；非键盘来源（按钮/菜单复用同一动作）为 null。 */
  readonly event: KeyboardEvent | null;
}

export interface NekActionHandler {
  readonly enabled?: boolean;
  readonly disabledReason?: { id: string; values?: Record<string, string | number> };
  /** 返回 false 表示本次没有目标可执行；派发器随后不 preventDefault，也不吞按键。 */
  readonly run: (context: NekActionDispatchContext) => boolean | void;
}

export type NekActionHandlers = Partial<Record<NekActionId, NekActionHandler | null>>;

interface HandlerRegistration {
  readonly handlersRef: { current: NekActionHandlers };
  readonly priority: number;
}

const registrations = new Map<string, HandlerRegistration>();
/** 单体渲染进程内的 action 目标上限：异常注册不会无限增长。 */
const MAX_HANDLER_REGISTRATIONS = 32;
let nextOwnerId = 0;

/**
 * 动作的派发阶段：composer 动作永远让内层编辑控件先手，
 * 全局动作按定义显式声明（默认 capture）。
 */
export function resolveNekActionDispatchPhase(actionId: NekActionId): NekActionDispatchPhase {
  const action = getNekAction(actionId);
  if (action.scope === "composer") return "bubble";
  return action.dispatchPhase ?? "capture";
}

/**
 * 按事件解析命中的动作。
 *
 * 全局动作优先于 composer 动作（同键时全局语义更具体）；可编辑元素内只放行
 * `allowInEditable` 的全局动作。只返回属于 `phase` 的动作，避免两个阶段重复消费同一个键。
 * IME、repeat 等噪声由 shortcuts 内核的匹配器统一过滤。
 */
export function resolveNekActionKeyboardEvent(
  event: ShortcutBindingEvent,
  effective: EffectiveActionBindings = resolveEffectiveActionBindings(),
  editableTarget = false,
  platformInfo?: KeyboardShortcutPlatformInfo,
  phase: NekActionDispatchPhase = "capture",
): NekActionId | null {
  const globalActionId = matchActionEvent(event, effective, "global", platformInfo);
  if (globalActionId !== null) {
    if (editableTarget && !getNekAction(globalActionId).allowInEditable) return null;
    return resolveNekActionDispatchPhase(globalActionId) === phase ? globalActionId : null;
  }
  if (!editableTarget) return null;
  const composerActionId = matchActionEvent(event, effective, "composer", platformInfo);
  if (composerActionId === null) return null;
  return resolveNekActionDispatchPhase(composerActionId) === phase ? composerActionId : null;
}

/** 注册一个 pane/app 的当前动作处理器；cleanup 后不会残留旧 pane 的回调。 */
export function registerNekActionHandlers(handlers: NekActionHandlers, priority = 0): () => void {
  return registerNekActionHandlersRef({ current: handlers }, priority);
}

function registerNekActionHandlersRef(
  handlersRef: { current: NekActionHandlers },
  priority: number,
): () => void {
  const ownerId = `nek-action-owner-${nextOwnerId++}`;
  registrations.set(ownerId, { handlersRef, priority });
  for (const oldestId of registrations.keys()) {
    if (registrations.size <= MAX_HANDLER_REGISTRATIONS) break;
    registrations.delete(oldestId);
  }
  return () => {
    registrations.delete(ownerId);
  };
}

function currentHandler(actionId: NekActionId): NekActionHandler | null {
  const candidates = [...registrations.values()]
    .map((registration) => ({
      handler: registration.handlersRef.current[actionId],
      priority: registration.priority,
    }))
    .filter(
      (candidate): candidate is { handler: NekActionHandler; priority: number } =>
        candidate.handler !== null && candidate.handler !== undefined,
    )
    .sort((left, right) => right.priority - left.priority);
  return candidates[0]?.handler ?? null;
}

/**
 * 只对已注册、enabled 且真正执行了目标的动作返回 true。
 * 返回 false 时调用方不得 preventDefault，避免「没反应还吞掉浏览器默认行为」。
 */
export function dispatchNekAction(actionId: NekActionId, event: KeyboardEvent | null = null): boolean {
  const handler = currentHandler(actionId);
  if (!handler || handler.enabled === false) return false;
  return handler.run({ event }) !== false;
}

/** 在宿主组件中挂载唯一的 window 键盘通道（capture + bubble 两段）。 */
export function useNekActionKeyboard(platformInfo?: KeyboardShortcutPlatformInfo): void {
  const platformInfoRef = useRef(platformInfo);
  platformInfoRef.current = platformInfo;

  useEffect(() => {
    const dispatch = (event: KeyboardEvent, phase: NekActionDispatchPhase): void => {
      if (event.repeat || event.isComposing || isShortcutRecordingActive()) return;
      // 内层组件已经消费这次按键（对话框关闭、mention/slash 面板 Esc）时让路。
      if (phase === "bubble" && event.defaultPrevented) return;
      const actionId = resolveNekActionKeyboardEvent(
        event,
        resolveEffectiveActionBindings(getActionShortcutOverrides()),
        isEditableShortcutEventTarget(event.target),
        platformInfoRef.current,
        phase,
      );
      if (actionId === null || !dispatchNekAction(actionId, event)) return;
      event.preventDefault();
    };

    const handleCapture = (event: KeyboardEvent) => dispatch(event, "capture");
    const handleBubble = (event: KeyboardEvent) => dispatch(event, "bubble");

    window.addEventListener("keydown", handleCapture, true);
    window.addEventListener("keydown", handleBubble);
    return () => {
      window.removeEventListener("keydown", handleCapture, true);
      window.removeEventListener("keydown", handleBubble);
    };
  }, []);
}

/** React pane/app 注册桥；enabled=false 时整体注销，按键自然回落到宿主默认行为。 */
export function useNekActionHandlers(
  handlers: NekActionHandlers,
  enabled = true,
  priority = 0,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    return registerNekActionHandlersRef(handlersRef, priority);
  }, [enabled, priority]);
}

export function resetNekActionHandlersForTest(): void {
  registrations.clear();
  nextOwnerId = 0;
}
