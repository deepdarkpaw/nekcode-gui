// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationAssistantWorkRenderItem } from "./conversationAssistantWorkItems.js";
import { ConversationWorkWindow } from "./ConversationWorkWindow.js";

afterEach(cleanup);

it("mounting a long work window never rewrites the shared timeline scroll position", () => {
  const timeline = document.createElement("div");
  timeline.dataset.v4TimelineScroll = "true";
  document.body.append(timeline);
  timeline.scrollTop = 5000;
  const scrollTo = vi.spyOn(timeline, "scrollTo");
  const items = Array.from(
    { length: 80 },
    (_, index) => ({ key: `work-${index}` }) as unknown as ConversationAssistantWorkRenderItem,
  );

  render(<ConversationWorkWindow items={items} renderItem={(item) => <div>{item.key}</div>} />, {
    container: timeline,
  });

  // 长轮次挂载时内层 virtualizer 曾按 initialOffset=0 回写，整条会话被拽回顶部。
  expect(scrollTo).not.toHaveBeenCalled();
  expect(timeline.scrollTop).toBe(5000);
  timeline.remove();
});
