// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationAssistantWorkRenderItem } from "./conversationAssistantWorkItems.js";
import { ConversationWorkWindow } from "./ConversationWorkWindow.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("HS1: a long work window mounts at the current timeline offset without writing to it", () => {
  const timeline = document.createElement("div");
  timeline.dataset.v4TimelineScroll = "true";
  document.body.append(timeline);
  timeline.scrollTop = 5000;
  const scrollTo = vi.spyOn(timeline, "scrollTo");
  Object.defineProperties(timeline, { offsetWidth: { value: 900 }, offsetHeight: { value: 600 } });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(72);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-history-work-window")
        ? new DOMRect(0, -3500, 900, 80 * 72)
        : new DOMRect(0, 0, 900, 600);
    },
  );
  const items = Array.from(
    { length: 80 },
    (_, index) => ({ key: `work-${index}` }) as unknown as ConversationAssistantWorkRenderItem,
  );

  try {
    const view = render(
      <ConversationWorkWindow items={items} renderItem={(item) => <div>{item.key}</div>} />,
      { container: timeline },
    );
    // Work starts 1500px into the document: the viewport already reads around item 48.
    // No native scroll event occurs merely because this turn entered the outer overscan.
    expect(view.queryByText("work-0")).toBeNull();
    expect(view.getByText("work-48")).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(timeline.scrollTop).toBe(5000);
  } finally {
    timeline.remove();
  }
});
