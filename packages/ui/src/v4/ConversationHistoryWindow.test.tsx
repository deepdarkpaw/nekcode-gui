// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TID_V4_TIMELINE } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTimeline } from "./ConversationTimeline.js";

const context = {
  workspacePath: "/project",
  sessionId: "parent",
  theme: "dark" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};
afterEach(cleanup);

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
  const { getByTestId } = render(<ZCodeIntlProvider initialLocale="zh-CN"><ConversationTimeline
    rows={[]} totalCount={140} sessionKey="parent" rowContext={context} canLoadOlder onLoadOlder={older}
    headerSlot={<div data-v4-timeline-scroll data-testid="nested-viewer">Tool extras</div>}
  /></ZCodeIntlProvider>);
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
