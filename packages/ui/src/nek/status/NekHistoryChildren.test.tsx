// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NekHistoryChildren, NekStatusSnapshot } from "@zcode/shared/nek-protocol";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { NekSubagentStatusSection } from "./NekSubagentStatusSection.js";
import { createNekSessionStatus, reduceNekStatusEvent } from "./reducer.js";
import { useNekStatusStore } from "./store.js";

const children: NekHistoryChildren = {
  total: 71,
  loaded: 1,
  complete: false,
  hasMore: true,
  nextCursor: "opaque-directory",
  items: [
    {
      id: "stored-child",
      status: "aborted",
      description: "Inspect old history",
      spawnEntryId: "spawn",
      spawnPosition: 1,
      detached: true,
    },
  ],
};
afterEach(() => {
  cleanup();
  useNekStatusStore.setState({ sessions: {} });
});

it("HS6: a stored child outside the transcript page remains reachable without becoming stoppable", async () => {
  useNekStatusStore.setState({
    sessions: { parent: { ...createNekSessionStatus(), historyChildren: children } },
  });
  const onOpen = vi.fn();
  const onStop = vi.fn();
  const { container } = render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <NekSubagentStatusSection sessionKey="parent" onOpenTranscript={onOpen} onStop={onStop} />
    </ZCodeIntlProvider>,
  );
  fireEvent.click(container.querySelector("button[aria-expanded]")!);
  fireEvent.click(await screen.findByRole("button", { name: "在右侧预览 Inspect old history" }));
  expect(onOpen).toHaveBeenCalledWith("stored-child");
  expect(onStop).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /^停止/ })).toBeNull();
  expect(screen.getByText("另有 70 个子代理，可从任务记录中的链接打开")).toBeTruthy();
});

it("HS6: live records win without duplicating their stored directory row", () => {
  const live = {
    id: "stored-child",
    type: "worker",
    description: "Live child",
    status: "running" as const,
    background: true,
    startedAt: Date.now(),
  };
  useNekStatusStore.setState({
    sessions: {
      parent: {
        ...createNekSessionStatus(),
        historyChildren: children,
        subagents: { order: [live.id], byId: { [live.id]: live } },
      },
    },
  });
  const { container } = render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <NekSubagentStatusSection sessionKey="parent" onOpenTranscript={vi.fn()} onStop={vi.fn()} />
    </ZCodeIntlProvider>,
  );
  expect(
    container.querySelector("[data-subagent-count]")?.getAttribute("data-subagent-count"),
  ).toBe("1");
  fireEvent.click(container.querySelector("button[aria-expanded]")!);
  expect(screen.queryByText("Inspect old history")).toBeNull();
  expect(screen.getByText("Live child")).toBeTruthy();
});

it("HS6: snapshot metadata remains bounded and is cleared by the next authoritative snapshot", () => {
  const payload = {
    sessionKey: "parent",
    running: false,
    compacting: false,
    pendingMessageCount: 0,
    state: { mode: "agent", todos: [], plans: [], subagents: [] },
    stats: {
      sessionFile: undefined,
      sessionId: "parent",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    historyChildren: {
      ...children,
      items: Array.from({ length: 80 }, (_, i) => ({ ...children.items![0]!, id: `child-${i}` })),
    },
  } as NekStatusSnapshot;
  const loaded = reduceNekStatusEvent(createNekSessionStatus(), "parent", {
    type: "session_snapshot",
    payload,
  }).state;
  expect(loaded.historyChildren?.items).toHaveLength(50);
  expect(loaded.subagents.order).toHaveLength(0);
  const cleared = reduceNekStatusEvent(loaded, "parent", {
    type: "session_snapshot",
    payload: { ...payload, historyChildren: undefined },
  }).state;
  expect(cleared.historyChildren).toBeUndefined();
});
