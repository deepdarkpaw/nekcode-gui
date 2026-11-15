import { useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationAssistantWorkRenderItem } from "./conversationAssistantWorkItems.js";
import { ConversationTimelineScrollPolicyContext } from "./conversationTimelineScrollPolicy.js";

interface WorkWindowProps {
  items: readonly ConversationAssistantWorkRenderItem[];
  renderItem: (item: ConversationAssistantWorkRenderItem) => ReactNode;
  pinTail?: boolean;
}

/** Small work groups keep their existing DOM; only long, expanded logical sequences need another window. */
export function ConversationWorkWindow(props: WorkWindowProps) {
  if (props.items.length <= 60)
    return <div className="flex flex-col gap-4">{props.items.map(props.renderItem)}</div>;
  return <VirtualWorkWindow {...props} />;
}

function ignoreNestedScrollWrite(): void {}

/** Shares the timeline scroll container: no nested scrollbar and no unbounded mounted live turn. */
function VirtualWorkWindow({ items, renderItem, pinTail = false }: WorkWindowProps) {
  const root = useRef<HTMLDivElement>(null);
  const scrollPolicy = useContext(ConversationTimelineScrollPolicyContext);
  const [scrollMargin, setScrollMargin] = useState(0);
  const getScrollElement = useCallback(
    () => root.current?.closest<HTMLDivElement>("[data-v4-timeline-scroll]") ?? null,
    [],
  );
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const visible = defaultRangeExtractor(range);
      if (pinTail && !visible.includes(items.length - 1)) visible.push(items.length - 1);
      return visible;
    },
    [items.length, pinTail],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    getItemKey,
    getScrollElement,
    estimateSize: () => 72,
    overscan: 4,
    scrollMargin,
    rangeExtractor,
    // 滚动容器归 timeline 所有。内层 virtualizer 挂载时会按缓存的 initialOffset(0)
    // 回写 scrollTop，长轮次一挂载就把整条会话拽回顶部；其测高补偿也无视跟随底部，
    // 会把刚回到底部的视口推离底部。内层永不直接写滚动位置，补偿交给 timeline 裁决。
    scrollToFn: ignoreNestedScrollWrite,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta) => {
    scrollPolicy?.compensateNestedItemResize(item.end, delta);
    return false;
  };
  useLayoutEffect(() => {
    const element = root.current;
    const scroll = getScrollElement();
    if (!element || !scroll) return;
    const measureOffset = () => {
      const offset =
        element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      setScrollMargin((previous) => (Math.abs(previous - offset) < 0.5 ? previous : offset));
    };
    measureOffset();
    const observer = new ResizeObserver(measureOffset);
    observer.observe(scroll);
    if (element.parentElement) observer.observe(element.parentElement);
    scroll.addEventListener("scroll", measureOffset, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", measureOffset);
    };
  }, [getScrollElement]);
  return (
    <div
      ref={root}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
      data-history-work-window={items.length}
      data-mounted-work-items={virtualizer.getVirtualItems().length}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          ref={virtualizer.measureElement}
          data-index={item.index}
          className={
            item.index === items.length - 1
              ? "absolute left-0 top-0 w-full"
              : "absolute left-0 top-0 w-full pb-4"
          }
          style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
        >
          {renderItem(items[item.index]!)}
        </div>
      ))}
    </div>
  );
}
