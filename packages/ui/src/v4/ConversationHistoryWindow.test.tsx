// @vitest-environment happy-dom
import { useContext, useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TID_V4_TIMELINE } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "./ConversationTimeline.js";
import { HISTORY_BOUNDARY_REFRESH_REQUIRED } from "./conversationHistoryWindow.js";
import { ConversationTimelineScrollPolicyContext } from "./conversationTimelineScrollPolicy.js";
import { livePage, liveRow } from "./liveHistoryRenderer.testFixtures.js";
import type { ConversationHistoryControls } from "./useConversationHistoryControls.js";

const context = {
  workspacePath: "/project",
  sessionId: "parent",
  theme: "dark" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};
afterEach(cleanup);

it("LCB4/LCB5: back to bottom refreshes an invalid boundary even when hasNewer is false", async () => {
  const loadLatest = vi.fn(async () => true);
  const controls: ConversationHistoryControls = {
    history: livePage(0, 20).history,
    error: HISTORY_BOUNDARY_REFRESH_REQUIRED,
    loading: false,
    directoryQuery: null,
    directory: {
      items: [],
      totalTurns: 20,
      hasMore: false,
      loading: false,
      error: null,
      loadMore: vi.fn(),
      reload: vi.fn(),
    },
    loadOlder: vi.fn(),
    loadNewer: vi.fn(),
    loadAround: vi.fn(),
    loadOldest: vi.fn(),
    loadLatest,
    retry: vi.fn(),
  };
  const bottom = { current: null as (() => void) | null };
  const view = (historyControls: ConversationHistoryControls) => (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ConversationTimeline
        rows={[]}
        totalCount={0}
        sessionKey="parent"
        rowContext={context}
        historyControls={historyControls}
        scrollToBottomActionRef={bottom}
      />
    </ZCodeIntlProvider>
  );
  const { getByTestId, rerender } = render(view(controls));
  await act(async () => {
    bottom.current!();
    bottom.current!();
  });
  expect(loadLatest).toHaveBeenCalledOnce();
  rerender(view({ ...controls, error: null }));
  expect(getByTestId(TID_V4_TIMELINE).dataset.following).toBe("true");
  await act(async () => bottom.current!());
  expect(loadLatest).toHaveBeenCalledOnce();
});

it("HP1/RH1: mount and layout scroll do not fetch history; upward wheel admits only one page", () => {
  const older = vi.fn();
  const all = vi.fn();
  const legacy = { onLoadAllOlder: all };
  const { getByTestId } = render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ConversationTimeline
        rows={[]}
        totalCount={140}
        sessionKey="parent"
        rowContext={context}
        canLoadOlder
        onLoadOlder={older}
        {...legacy}
      />
    </ZCodeIntlProvider>,
  );
  const scroll = getByTestId(TID_V4_TIMELINE);
  fireEvent.scroll(scroll);
  expect(older).not.toHaveBeenCalled();
  expect(all).not.toHaveBeenCalled();
  fireEvent.wheel(scroll, { deltaY: -30 });
  expect(older).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 10; index += 1) fireEvent.scroll(scroll);
  expect(older).toHaveBeenCalledTimes(1);
  expect(all).not.toHaveBeenCalled();
  fireEvent.wheel(scroll, { deltaY: -30 });
  expect(older).toHaveBeenCalledTimes(2);
});

it("RH1/LR5: a nested tool viewer never requests older conversation pages", () => {
  const older = vi.fn();
  const { getByTestId } = render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ConversationTimeline
        rows={[]}
        totalCount={140}
        sessionKey="parent"
        rowContext={context}
        canLoadOlder
        onLoadOlder={older}
        headerSlot={
          <div data-v4-timeline-scroll data-testid="nested-viewer">
            Tool extras
          </div>
        }
      />
    </ZCodeIntlProvider>,
  );
  fireEvent.wheel(getByTestId("nested-viewer"), { deltaY: -30 });
  fireEvent.scroll(getByTestId(TID_V4_TIMELINE));
  expect(older).not.toHaveBeenCalled();
  fireEvent.wheel(getByTestId(TID_V4_TIMELINE), { deltaY: -30 });
  expect(older).toHaveBeenCalledTimes(1);
});

it("RH1: downward wheel and an in-flight page cannot trigger older-history reads", () => {
  const older = vi.fn();
  const { getByTestId } = render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <ConversationTimeline
        rows={[]}
        totalCount={140}
        sessionKey="parent"
        rowContext={context}
        canLoadOlder
        loadingOlder
        onLoadOlder={older}
      />
    </ZCodeIntlProvider>,
  );
  const scroll = getByTestId(TID_V4_TIMELINE);
  fireEvent.wheel(scroll, { deltaY: 30 });
  fireEvent.scroll(scroll);
  fireEvent.wheel(scroll, { deltaY: -30 });
  expect(older).not.toHaveBeenCalled();
});

function WorkResizeProbe({ independent }: { independent?: boolean }) {
  const windowRef = useRef<HTMLDivElement>(null);
  const policy = useContext(ConversationTimelineScrollPolicyContext);
  return (
    <div data-v4-turn-unit data-testid="resize-turn">
      <div data-v4-timeline-scroll={independent} ref={windowRef} data-testid="resize-window">
        <button onClick={() => policy?.compensateNestedItemResize(windowRef.current!, 72, 110)}>
          Resize work item
        </button>
      </div>
    </div>
  );
}

it.each([
  { name: "an offscreen turn entering overscan", turnBottom: 20, windowTop: -200, shift: 0 },
  { name: "a window starting below the viewport top", turnBottom: 500, windowTop: 100, shift: 0 },
  {
    name: "an item above the reading position in the current turn",
    turnBottom: 500,
    windowTop: -120,
    shift: 110,
  },
  {
    name: "an independent tool scroller",
    turnBottom: 500,
    windowTop: -120,
    independent: true,
    shift: 0,
  },
])(
  "HS2: only the owning virtualizer adjusts for $name",
  ({ turnBottom, windowTop, independent, shift }) => {
    const { getByTestId, getByRole } = render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <ConversationTimeline
          rows={[liveRow(0)]}
          totalCount={1}
          sessionKey="parent"
          rowContext={context}
          headerSlot={<WorkResizeProbe independent={independent} />}
        />
      </ZCodeIntlProvider>,
    );
    const scroll = getByTestId(TID_V4_TIMELINE);
    Object.defineProperties(scroll, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 2000 },
    });
    scroll.getBoundingClientRect = () => new DOMRect(0, 50, 800, 400);
    getByTestId("resize-turn").getBoundingClientRect = () =>
      new DOMRect(0, -300, 800, turnBottom + 300);
    getByTestId("resize-window").getBoundingClientRect = () => new DOMRect(0, windowTop, 800, 600);
    scroll.scrollTop = 500;
    fireEvent.wheel(scroll, { deltaY: -80 });
    expect(scroll.dataset.following).toBe("false");
    fireEvent.click(getByRole("button", { name: "Resize work item" }));
    expect(scroll.scrollTop).toBe(500 + shift);
  },
);
