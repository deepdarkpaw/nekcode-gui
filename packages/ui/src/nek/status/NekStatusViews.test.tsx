// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NekSessionStats, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useNekStatusStore } from "./store.js";
import { NekCompactionBannerView } from "./NekCompactionBannerView.js";
import { NekQueueBarView } from "./NekQueueBarView.js";
import { NekRetryBannerView } from "./NekRetryBannerView.js";
import { NekRunningSubagentsBarView } from "./NekRunningSubagentsBarView.js";
import { NekSessionStatusSlot, type NekSessionStatusCallbacks } from "./NekSessionStatusSlot.js";
import { NekSubagentCardView } from "./NekSubagentCardView.js";
import { NekSubagentTranscriptView } from "./NekSubagentTranscriptView.js";
import { NekTodoPanelView } from "./NekTodoPanelView.js";
import { NekUsageIndicatorView } from "./NekUsageIndicatorView.js";

function wrapper({ children }: PropsWithChildren) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}

function renderView(node: ReactNode) {
  return render(node, { wrapper });
}

function record(id: string, status: NekSubagentRecord["status"] = "running"): NekSubagentRecord {
  return {
    id,
    description: `子代理 ${id}`,
    type: "worker",
    model: "model",
    background: true,
    status,
    startedAt: 0,
    ...(status === "running" ? { activity: "正在处理" } : { endedAt: 1000 }),
    ...(status === "completed" ? { finalText: "已完成正文" } : {}),
  };
}

function setTodoState() {
  useNekStatusStore.getState().consumeEvent("s", {
    type: "nek.state",
    payload: {
      mode: "agent",
      todos: [{ id: "todo-1", content: "检查状态", status: "pending" }],
      plans: [],
      subagents: [],
    },
  });
}

function setStats() {
  const stats: NekSessionStats = {
    sessionFile: undefined,
    sessionId: "s",
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 42_000, output: 3_000, cacheRead: 4_000, cacheWrite: 500, total: 49_500 },
    cost: 1.23,
    contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
  };
  useNekStatusStore.getState().consumeEvent("s", { type: "session_stats", payload: stats });
}

function callbacks(overrides: Partial<NekSessionStatusCallbacks> = {}): NekSessionStatusCallbacks {
  return {
    onStopSubagent: vi.fn(async () => undefined),
    fetchTranscript: vi.fn(async () => ({ messages: [] })),
    onFocusSubagent: vi.fn(),
    onOpenPlan: vi.fn(),
    onJumpToTodo: vi.fn(),
    canJumpToTodo: () => true,
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    requeue: vi.fn(async () => undefined),
    getComposerText: () => "",
    setComposerText: vi.fn(),
    focusComposerAtEnd: vi.fn(),
    abortRetry: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    abortCompaction: vi.fn(async () => undefined),
    onCompact: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => useNekStatusStore.getState().reset());
afterEach(() => cleanup());

describe("nek status views", () => {
  it("SA: renders a card, collapses by default, and opens its body", () => {
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a", "completed") });
    renderView(
      <NekSubagentCardView
        sessionKey="s"
        id="a"
        onStop={vi.fn(async () => undefined)}
        onOpenTranscript={vi.fn()}
      />,
    );
    const card = document.querySelector('[data-status-view="subagent-card"]');
    expect(card?.getAttribute("data-state")).toBe("closed");
    expect(screen.getByText("子代理 a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /子代理 a/ }));
    expect(card?.getAttribute("data-state")).toBe("open");
    expect(screen.getByText("已完成正文")).toBeTruthy();
  });

  it("SA: renders disabled reason while stop is pending", async () => {
    let resolveStop: (() => void) | undefined;
    const onStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = resolve;
        }),
    );
    useNekStatusStore.getState().consumeEvent("s", { type: "nek.subagent", payload: record("a") });
    renderView(
      <NekSubagentCardView sessionKey="s" id="a" onStop={onStop} onOpenTranscript={vi.fn()} />,
    );
    fireEvent.click(document.querySelector('[data-status-action="stop"]') as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="disabled-reason-trigger"]')).toBeTruthy(),
    );
    resolveStop?.();
  });

  it("RB: limits items, expands overflow, and focuses an item", () => {
    const onFocus = vi.fn();
    for (const id of ["a", "b", "c", "d"]) {
      useNekStatusStore.getState().consumeEvent("s", { type: "nek.subagent", payload: record(id) });
    }
    renderView(
      <NekRunningSubagentsBarView sessionKey="s" onStop={vi.fn()} onFocusSubagent={onFocus} />,
    );
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.queryByText("子代理 d")).toBeNull();
    fireEvent.click(screen.getByText("子代理 a"));
    expect(onFocus).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByText("+1"));
    expect(screen.getByText("子代理 d")).toBeTruthy();
  });

  it("TD: renders summary, jumpable items, and plan action", () => {
    setTodoState();
    const onJump = vi.fn();
    const onOpenPlan = vi.fn();
    useNekStatusStore.getState().consumeEvent("s", {
      type: "nek.state",
      payload: {
        mode: "agent",
        todos: [{ id: "todo-1", content: "检查状态", status: "pending" }],
        plans: [],
        activePlanPath: "plan.md",
        subagents: [],
      },
    });
    renderView(
      <NekTodoPanelView
        sessionKey="s"
        onOpenPlan={onOpenPlan}
        onJumpToTodo={onJump}
        canJumpToTodo={() => true}
      />,
    );
    expect(screen.getByText("0/1 已完成")).toBeTruthy();
    fireEvent.click(screen.getByText("检查状态"));
    expect(onJump).toHaveBeenCalledWith("todo-1");
    fireEvent.click(screen.getByRole("button", { name: "查看计划" }));
    expect(onOpenPlan).toHaveBeenCalledWith("plan.md");
  });

  it("QB: renders queue labels, retrieves all, and opens inline edit", async () => {
    const setComposerText = vi.fn();
    const clearQueue = vi.fn(async () => ({ steering: ["urgent"], followUp: ["later"] }));
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "queue_update", steering: ["urgent"], followUp: ["later"] });
    renderView(
      <NekQueueBarView
        sessionKey="s"
        clearQueue={clearQueue}
        requeue={vi.fn(async () => undefined)}
        getComposerText={() => "draft"}
        setComposerText={setComposerText}
        focusComposerAtEnd={vi.fn()}
      />,
    );
    expect(screen.getByText("插队")).toBeTruthy();
    expect(screen.getByText("排队")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全部取回到输入框" }));
    await waitFor(() => expect(clearQueue).toHaveBeenCalled());
    fireEvent.click(
      document.querySelector('[data-status-action="edit:steering:0"]') as HTMLElement,
    );
    expect(screen.getByDisplayValue("urgent")).toBeTruthy();
    expect(setComposerText).toHaveBeenCalledWith("urgent\n\nlater\n\ndraft");
  });

  it("RT and CP: show visible banners and error detail fold", () => {
    useNekStatusStore.getState().consumeEvent("s", {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 1000,
      errorMessage: "网络错误",
    });
    useNekStatusStore.getState().consumeEvent("s", {
      type: "auto_retry_end",
      success: false,
      attempt: 2,
      finalError: "网络错误\n完整诊断",
    });
    renderView(<NekRetryBannerView sessionKey="s" abortRetry={vi.fn()} abort={vi.fn()} />);
    expect(screen.getByText("重试 2 次后仍然失败")).toBeTruthy();
    fireEvent.click(screen.getByText("网络错误"));
    expect(document.querySelector("pre")?.textContent).toBe("网络错误\n完整诊断");
    cleanup();
    useNekStatusStore.getState().reset();
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "compaction_start", reason: "threshold" });
    renderView(<NekCompactionBannerView sessionKey="s" abortCompaction={vi.fn()} />);
    expect(screen.getByText("上下文接近上限，正在自动压缩")).toBeTruthy();
  });

  it("US: shows context summary, details, stale opacity, and compact action", () => {
    setStats();
    renderView(<NekUsageIndicatorView sessionKey="s" onCompact={vi.fn()} />);
    const indicator = document.querySelector('[data-status-view="usage-indicator"]');
    expect(indicator?.className).not.toContain("opacity-70");
    expect(screen.getByText("42% · 84k/200k")).toBeTruthy();
    fireEvent.click(screen.getByText("42% · 84k/200k"));
    expect(screen.getByText("Input:")).toBeTruthy();
    expect(screen.getByText("Cache Read:")).toBeTruthy();
  });

  it("TR: shows loading state and retries an initial failure", async () => {
    const fetchTranscript = vi
      .fn()
      .mockRejectedValueOnce(new Error("加载失败"))
      .mockResolvedValueOnce({ messages: ["消息一"] });
    renderView(
      <NekSubagentTranscriptView
        sessionKey="s"
        id="a"
        fetchTranscript={fetchTranscript}
        onBack={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText("加载失败")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "加载失败，重试" }));
    await waitFor(() => expect(screen.getByText("消息一")).toBeTruthy());
  });

  it("slot: returns null without active state and mounts active status views", () => {
    const empty = renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks()} />);
    expect(empty.container.querySelector('[data-status-view="session-status-slot"]')).toBeNull();
    empty.unmount();
    act(() => {
      useNekStatusStore
        .getState()
        .consumeEvent("s", { type: "queue_update", steering: ["one"], followUp: [] });
    });
    renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks()} />);
    expect(document.querySelector('[data-status-view="session-status-slot"]')).toBeTruthy();
    expect(screen.getByText("one")).toBeTruthy();
  });
});
