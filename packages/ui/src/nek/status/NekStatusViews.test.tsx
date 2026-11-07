// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NekSessionStats, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resetNekStatusActionRegistry } from "@/nek/statusFeed/statusActions.js";
import { useNekStatusStore } from "./store.js";
import { NekCompactionBannerView } from "./NekCompactionBannerView.js";
import { NekQueueBarView } from "./NekQueueBarView.js";
import { NekRetryBannerView } from "./NekRetryBannerView.js";
import { NekRunningSubagentsBarView } from "./NekRunningSubagentsBarView.js";
import { NekSubagentCardView } from "./NekSubagentCardView.js";
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

beforeEach(() => {
  useNekStatusStore.getState().reset();
  resetNekStatusActionRegistry();
});
afterEach(() => cleanup());

describe("nek status views", () => {
  it("S1: completed card opens the side preview, never duplicates raw final text", () => {
    const openPreview = vi.fn();
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a", "completed") });
    renderView(
      <NekSubagentCardView
        sessionKey="s"
        id="a"
        onStop={vi.fn(async () => undefined)}
        onOpenTranscript={openPreview}
      />,
    );
    expect(screen.getByText("子代理 a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在右侧预览 子代理 a" }));
    expect(openPreview).toHaveBeenCalledWith("a");
    expect(screen.queryByText("已完成正文")).toBeNull();
    expect(screen.queryByText("查看完整消息")).toBeNull();
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

  it("TD-icons: uses 14px status icons and strikes through completed items", () => {
    useNekStatusStore.getState().consumeEvent("s", {
      type: "nek.state",
      payload: {
        mode: "agent",
        todos: [
          { id: "todo-done", content: "已完成的事项", status: "completed" },
          { id: "todo-run", content: "正在做的事项", status: "in_progress" },
          { id: "todo-wait", content: "还没开始的事项", status: "pending" },
          { id: "todo-drop", content: "取消的事项", status: "cancelled" },
        ],
        plans: [],
        subagents: [],
      },
    });
    renderView(
      <NekTodoPanelView
        sessionKey="s"
        onOpenPlan={vi.fn()}
        onJumpToTodo={vi.fn()}
        canJumpToTodo={() => false}
      />,
    );
    // 每个状态图标都必须显式带 size-3.5；漏写 size-* 时 Lucide 会退回 24px 巨型图标。
    const icons = Array.from(document.querySelectorAll('[data-status-view="todo-panel"] ul svg'));
    expect(icons).toHaveLength(4);
    for (const icon of icons) {
      expect(icon.getAttribute("class") ?? "").toContain("size-3.5");
    }
    const completedText = Array.from(
      document.querySelector('[data-todo-status="completed"]')?.querySelectorAll("span") ?? [],
    ).find((span) => span.textContent === "已完成的事项");
    expect(completedText?.className).toContain("line-through");
    expect(completedText?.className).toContain("text-foreground-subtlest");
    const runningText = Array.from(
      document.querySelector('[data-todo-status="in_progress"]')?.querySelectorAll("span") ?? [],
    ).find((span) => span.textContent === "正在做的事项");
    expect(runningText?.className).not.toContain("line-through");
  });

  it("QB: renders the queue title count, multiline text, and the edit entry", async () => {
    const setComposerText = vi.fn();
    const clearQueue = vi.fn(async () => ({ steering: ["第一行\n第二行"], followUp: ["later"] }));
    useNekStatusStore.getState().consumeEvent("s", {
      type: "queue_update",
      steering: ["第一行\n第二行"],
      followUp: ["later"],
    });
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
    // 标题必须是队列计数，而不是清空按钮的文案。
    const title = document.querySelector('[data-status-view="queue-bar"] header > span');
    expect(title?.textContent).toBe("待发送消息（2）");
    expect(title?.textContent).not.toBe("清空队列");
    expect(screen.getByText("插队")).toBeTruthy();
    expect(screen.getByText("排队")).toBeTruthy();
    // 多行排队消息完整显示，右侧按钮不会和正文重叠（正文是独立的 min-w-0 flex-1 列）。
    const steeringRow = document.querySelector('[data-queue-item="steering:0"]');
    expect(steeringRow?.textContent).toContain("第一行\n第二行");
    fireEvent.click(screen.getByRole("button", { name: "全部取回到输入框" }));
    await waitFor(() => expect(clearQueue).toHaveBeenCalled());
    expect(setComposerText).toHaveBeenCalledWith("第一行\n第二行\n\nlater\n\ndraft");
  });

  it("QB-edit: multiline textarea keeps Shift+Enter newlines and commits on Enter", async () => {
    const clearQueue = vi.fn(async () => ({ steering: ["第一行\n第二行"], followUp: [] }));
    const requeue = vi.fn(async () => undefined);
    useNekStatusStore.getState().consumeEvent("s", {
      type: "queue_update",
      steering: ["第一行\n第二行"],
      followUp: [],
    });
    renderView(
      <NekQueueBarView
        sessionKey="s"
        clearQueue={clearQueue}
        requeue={requeue}
        getComposerText={() => ""}
        setComposerText={vi.fn()}
        focusComposerAtEnd={vi.fn()}
      />,
    );
    fireEvent.click(
      document.querySelector('[data-status-action="edit:steering:0"]') as HTMLElement,
    );
    const textarea = document.querySelector(
      '[data-status-view="queue-bar"] textarea',
    ) as HTMLTextAreaElement | null;
    expect(textarea).toBeTruthy();
    expect(textarea?.value).toBe("第一行\n第二行");
    // Shift+Enter 是换行，绝不能提交或取消。
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: "Enter", shiftKey: true });
    expect(requeue).not.toHaveBeenCalled();
    expect(document.querySelector('[data-status-view="queue-bar"] textarea')).toBeTruthy();
    fireEvent.change(textarea as HTMLTextAreaElement, {
      target: { value: "改后第一行\n改后第二行" },
    });
    fireEvent.keyDown(textarea as HTMLTextAreaElement, { key: "Enter" });
    await waitFor(() =>
      expect(requeue).toHaveBeenCalledWith({
        steering: ["改后第一行\n改后第二行"],
        followUp: [],
      }),
    );
  });

  it("QB-edit: Escape cancels editing without touching the queue", async () => {
    const clearQueue = vi.fn(async () => ({ steering: ["原始"], followUp: [] }));
    const requeue = vi.fn(async () => undefined);
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "queue_update", steering: ["原始"], followUp: [] });
    renderView(
      <NekQueueBarView
        sessionKey="s"
        clearQueue={clearQueue}
        requeue={requeue}
        getComposerText={() => ""}
        setComposerText={vi.fn()}
        focusComposerAtEnd={vi.fn()}
      />,
    );
    fireEvent.click(
      document.querySelector('[data-status-action="edit:steering:0"]') as HTMLElement,
    );
    const textarea = document.querySelector(
      '[data-status-view="queue-bar"] textarea',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "改到一半" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    await waitFor(() =>
      expect(document.querySelector('[data-status-view="queue-bar"] textarea')).toBeNull(),
    );
    expect(requeue).not.toHaveBeenCalled();
    expect(clearQueue).not.toHaveBeenCalled();
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
});
