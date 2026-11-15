// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TID_V4_TIMELINE } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "./ConversationTimeline.js";
import { HISTORY_BOUNDARY_REFRESH_REQUIRED } from "./conversationHistoryWindow.js";
import { livePage } from "./liveHistoryRenderer.testFixtures.js";
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
