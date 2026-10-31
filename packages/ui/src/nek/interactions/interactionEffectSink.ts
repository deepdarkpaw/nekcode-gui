/**
 * 交互 store 的 fire-and-forget 出口。
 *
 * `useNekInteractionStore` 的 store 只负责"收"：`notify` / `setStatus` / `setWidget` /
 * `setTitle` / `set_editor_text` 这些不需要回答的请求会把效果写进会话槽的出站队列
 * （有界 64，见 `interactionSessionState.ts`）。本模块把队列接到**现有** UI：
 *
 * | 效果 | 去向 | 依据 |
 * | --- | --- | --- |
 * | `toast`（notify） | 现有 `components/ui/toast` 提示 | 01-interactions §5 |
 * | `replaceComposerText`（set_editor_text） | workspace 级 composer 一次性插入请求 | 01-interactions §5 |
 * | `setStatus` / `setWidget` / `setTitle` | 只落会话状态（`statuses` / `widgets` / `titleOverride`），不另造视图 | 01-interactions §5 |
 * | 一次性提示（`cancelledByHost` / `timedOut`） | 现有 toast，文案走 i18n | 00-common §5.2 |
 *
 * 为什么不给 `setStatus` / `setWidget` / `setTitle` 弹 toast：规格只要求它们更新状态，
 * nek 侧对应的 todo / plan / subagent 视图已经由 `nek.state` 帧驱动；把它们塞进 toast
 * 属于自造交互，规格没有定义。
 */
import { logger as defaultLogger } from "@/logger.js";
import type { NekExtensionUiEffect } from "./extensionUi.js";
import type { NekInteractionStoreApi } from "./interactionStore.js";

export type NekEffectNotifyLevel = "info" | "warning" | "error";

export interface NekInteractionEffectSinkOptions {
  store: NekInteractionStoreApi;
  sessionKey: string;
  /** 提示文案 id → 本地化文本（一次性提示只给 id）。 */
  formatMessage: (id: string) => string;
  /** 把文本写进输入框并聚焦；宿主没有 composer 时不传。 */
  replaceComposerText?: (text: string) => void;
  /** 展示一条提示；默认实现由宿主注入现有 toast。 */
  notify: (message: string, level: NekEffectNotifyLevel) => void;
  logger?: { warn: (...args: unknown[]) => void };
}

/**
 * 取走并消费一个会话槽里全部待处理的效果与一次性提示。
 *
 * 返回值只用于测试与诊断：本次真正处理了多少条。
 */
export function drainNekInteractionEffects({
  store,
  sessionKey,
  formatMessage,
  replaceComposerText,
  notify,
  logger = defaultLogger,
}: NekInteractionEffectSinkOptions): number {
  const effects = store.getState().takeEffects(sessionKey);
  for (const effect of effects) {
    applyEffect(effect, { sessionKey, replaceComposerText, notify, logger });
  }
  const notices = store.getState().takeNotices(sessionKey);
  for (const notice of notices) notify(formatMessage(notice.id), "info");
  return effects.length + notices.length;
}

function applyEffect(
  effect: NekExtensionUiEffect,
  context: {
    sessionKey: string;
    replaceComposerText?: (text: string) => void;
    notify: (message: string, level: NekEffectNotifyLevel) => void;
    logger: { warn: (...args: unknown[]) => void };
  },
): void {
  switch (effect.kind) {
    case "toast":
      context.notify(effect.message, effect.level);
      return;
    case "replaceComposerText":
      if (!context.replaceComposerText) {
        // 没有 composer 宿主时不能静默吞掉：nek 侧已经认为文本替换完成，GUI 却什么都没发生。
        context.logger.warn("[NekInteractionStore] set_editor_text without a composer host", {
          sessionKey: context.sessionKey,
          id: effect.id,
        });
        return;
      }
      context.replaceComposerText(effect.text);
      return;
    case "setStatus":
    case "setWidget":
    case "setTitle":
      // 状态已在 applyFireAndForgetEffect 落进会话槽，这里只清出站队列。
      return;
  }
}
