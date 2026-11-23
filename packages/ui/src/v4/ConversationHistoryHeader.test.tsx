// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationHistoryHeader } from "./ConversationHistoryHeader.js";
import type { ConversationHistoryControls } from "./useConversationHistoryControls.js";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ZCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>{children}</TooltipProvider>
  </ZCodeIntlProvider>
);
afterEach(cleanup);

function controls(firstPosition: number, hasOlder: boolean): ConversationHistoryControls {
  return {
    history: {
      branchRevision: "rev",
      totalTurns: 60,
      turns: Array.from({ length: 20 }, (_, index) => ({
        turnId: `turn:${firstPosition + index}`,
        userEntryId: `entry:${firstPosition + index}`,
        position: firstPosition + index,
        preview: "question",
      })),
      hasOlder,
      hasNewer: false,
      ...(hasOlder ? { olderCursor: `before:${firstPosition}` } : {}),
    },
    directory: {
      items: [],
      loading: false,
      error: null,
      hasMore: false,
      totalTurns: 60,
      loadMore: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    } as unknown as ConversationHistoryControls["directory"],
    directoryQuery: null,
    error: null,
    loading: false,
    loadAround: vi.fn(async () => true),
    loadOldest: vi.fn(async () => null),
    loadLatest: vi.fn(async () => true),
    loadOlder: vi.fn(async () => {}),
    loadNewer: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
  };
}

it("HL1: the top of turns 40-60 offers one button that loads the earlier whole turns", async () => {
  const value = controls(40, true);
  const onLoadOlder = vi.fn(async () => {});
  render(<ConversationHistoryHeader controls={value} onLoadOlder={onLoadOlder} />, { wrapper });
  const button = screen.getByRole("button", { name: "加载更早的记录（还有 40 轮）" });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.click(button);
  await waitFor(() => expect(onLoadOlder).toHaveBeenCalledTimes(1));
  expect(value.loadOlder).not.toHaveBeenCalled();
});

it("HL1: the first loaded page has no load button and no per-turn loading copy", () => {
  render(<ConversationHistoryHeader controls={controls(0, false)} />, { wrapper });
  expect(screen.queryByRole("button")).toBeNull();
  expect(document.body.textContent).not.toMatch(/按需查看内容|加载本轮更多过程|已加载/);
});
