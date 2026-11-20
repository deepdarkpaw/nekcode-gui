import { createContext } from "react";

/**
 * Timeline 对共享滚动容器的唯一写入口。
 *
 * 长轮次的工作窗口（嵌套 virtualizer）与 timeline 共用同一个滚动容器；滚动权（跟随底部、
 * 恢复、宽度变化）只由 timeline 裁决。嵌套窗口不得自行写 scrollTop，测高补偿必须交给这里。
 */
export interface ConversationTimelineScrollPolicy {
  /** endInWindow is relative to the work window, not the shared viewport or a cached scroll margin. */
  compensateNestedItemResize(workWindow: HTMLElement, endInWindow: number, delta: number): void;
}

/** 没有 timeline（独立渲染/测试）时为 null：嵌套窗口不做任何滚动写入。 */
export const ConversationTimelineScrollPolicyContext =
  createContext<ConversationTimelineScrollPolicy | null>(null);
