// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PropsWithChildren, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NekSubagentRecord } from "@zcode/shared/nek-protocol";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { NekStatusActions } from "@/nek/statusFeed/statusActions.js";
import {
  resetNekStatusActionRegistry,
  setNekStatusActions,
} from "@/nek/statusFeed/statusActions.js";
import { NekSessionStatusSlot, type NekSessionStatusCallbacks } from "./NekSessionStatusSlot.js";
import { useNekStatusStore } from "./store.js";

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

function callbacks(overrides: Partial<NekSessionStatusCallbacks> = {}): NekSessionStatusCallbacks {
  return {
    onStopSubagent: vi.fn(async () => undefined),
    onFocusSubagent: vi.fn(),
    onOpenPlan: vi.fn(),
    onJumpToTodo: vi.fn(),
    canJumpToTodo: () => true,
    getComposerText: () => "",
    setComposerText: vi.fn(),
    focusComposerAtEnd: vi.fn(),
    ...overrides,
  };
}

/**
 * feed 在见到会话帧时登记的动作。状态卡只从注册表取这些 RPC 动作，
 * pane 只提供需要 composer / 侧栏 / 行跳转的回调（见 `NekSessionStatusCallbacks`）。
 */
function statusActions(overrides: Partial<NekStatusActions> = {}): NekStatusActions {
  return {
    abort: vi.fn(async () => undefined),
    abortRetry: vi.fn(async () => undefined),
    abortCompaction: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    clearQueue: vi.fn(async () => ({ steering: ["one"], followUp: [] })),
    requeue: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  useNekStatusStore.getState().reset();
  resetNekStatusActionRegistry();
});
afterEach(() => cleanup());

describe("Nek session status slot wiring", () => {
  it("slot: returns null without active state and mounts active status views", () => {
    const empty = renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks()} />);
    expect(empty.container.querySelector('[data-status-view="session-status-slot"]')).toBeNull();
    empty.unmount();
    act(() => {
      useNekStatusStore
        .getState()
        .consumeEvent("s", { type: "queue_update", steering: ["one"], followUp: [] });
    });
    setNekStatusActions("s", statusActions());
    renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks()} />);
    expect(document.querySelector('[data-status-view="session-status-slot"]')).toBeTruthy();
    expect(screen.getByText("one")).toBeTruthy();
  });

  it("slot: does not render RPC-bound views before the feed registers its actions", () => {
    act(() => {
      useNekStatusStore
        .getState()
        .consumeEvent("s", { type: "queue_update", steering: ["one"], followUp: [] });
    });
    const rendered = renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks()} />);
    expect(rendered.container.querySelector('[data-status-view="session-status-slot"]')).toBeNull();
  });

  it("S1: five subagents collapse into one compact section instead of stacked cards", () => {
    const stopSubagent = vi.fn(async () => undefined);
    const focusSubagent = vi.fn();
    act(() => {
      for (const [index, id] of ["a", "b", "c", "d", "e"].entries()) {
        useNekStatusStore.getState().consumeEvent("s", {
          type: "nek.subagent",
          payload: { ...record(id, index === 0 ? "running" : "completed"), startedAt: index },
        });
      }
    });
    setNekStatusActions("s", statusActions());
    renderView(
      <NekSessionStatusSlot
        sessionKey="s"
        callbacks={callbacks({
          onStopSubagent: stopSubagent,
          onFocusSubagent: focusSubagent,
        })}
      />,
    );

    // 5 个子代理只占一个折叠区：不再有逐个子代理的大卡片，也没有第二条运行中横栏。
    const sections = document.querySelectorAll<HTMLElement>(
      '[data-status-view="subagent-status-section"]',
    );
    expect(sections).toHaveLength(1);
    const section = sections[0];
    if (!section) throw new Error("expected the subagent status section");
    expect(document.querySelector('[data-status-view="subagent-card"]')).toBeNull();
    expect(document.querySelector('[data-status-view="running-subagents-bar"]')).toBeNull();
    expect(section.dataset.subagentCount).toBe("5");

    // 收起态：头部一行摘要（最长耗时 + 运行数），列表里没有任何子代理行。
    const summary = within(section);
    expect(summary.getByText("子代理")).toBeTruthy();
    expect(summary.getByText(/1\s*运行中/u)).toBeTruthy();
    expect(document.querySelectorAll('[data-status-view="subagent-row"]')).toHaveLength(0);

    fireEvent.click(summary.getByRole("button", { name: "子代理" }));
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-status-view="subagent-row"]'),
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.dataset.subagentId)).toEqual(["a", "b", "c", "d", "e"]);
    // 展开态内容固定在 max-h-48 的滚动容器内，5 个、20 个都不会撑爆状态槽。
    const list = rows[0]?.parentElement;
    expect(list?.className).toContain("max-h-48");
    expect(list?.className).toContain("overflow-y-auto");

    const first = rows[0];
    if (!first) throw new Error("expected a subagent row");
    fireEvent.click(within(first).getByRole("button", { name: "在右侧预览 子代理 a" }));
    expect(focusSubagent).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("button", { name: "查看完整消息" })).toBeNull();
    expect(document.querySelector('[data-status-view="subagent-transcript"]')).toBeNull();

    // 只有运行中的行带停止按钮，且停止只停这一条。
    expect(within(first).getByRole("button", { name: "停止 子代理 a" })).toBeTruthy();
    const completed = rows[1];
    if (!completed) throw new Error("expected a completed subagent row");
    expect(within(completed).queryByRole("button", { name: "停止 子代理 b" })).toBeNull();
    fireEvent.click(within(first).getByRole("button", { name: "停止 子代理 a" }));
    expect(stopSubagent).toHaveBeenCalledWith("a");
  });

  it("SS-4: a stop failure shows its full detail and keeps retry available", async () => {
    const detail =
      "nek extension_call failed: Unknown subagent 01a1c60d-1259-7107-a279-7223aff3ad42. Please inspect the parent session.";
    const onStopSubagent = vi
      .fn()
      .mockRejectedValueOnce(new Error(detail))
      .mockResolvedValue(undefined);
    useNekStatusStore.getState().consumeEvent("s", { type: "nek.subagent", payload: record("a") });
    setNekStatusActions("s", statusActions());
    renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks({ onStopSubagent })} />);
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    fireEvent.click(screen.getByRole("button", { name: "停止 子代理 a" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(detail);
    expect(alert.className).not.toContain("truncate");
    expect(alert.className).toContain("break-words");
    expect(
      useNekStatusStore.getState().sessions.s?.subagents.byId.a?.stopRequested,
    ).toBeUndefined();
    const retry = screen.getByRole("button", { name: "停止 子代理 a" });
    expect(retry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(onStopSubagent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("SS-1: restored absent children have no stop action even when the parent is running", () => {
    const onStopSubagent = vi.fn();
    useNekStatusStore.getState().consumeEvent("s", { type: "agent_start" });
    useNekStatusStore
      .getState()
      .consumeEvent("s", { type: "nek.subagent", payload: record("a", "aborted") });
    setNekStatusActions("s", statusActions());
    renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks({ onStopSubagent })} />);
    fireEvent.click(screen.getByRole("button", { name: "子代理" }));
    expect(screen.queryByRole("button", { name: "停止 子代理 a" })).toBeNull();
    expect(onStopSubagent).not.toHaveBeenCalled();
  });

  it("S2: an all-finished section shows the ended count instead of a running summary", () => {
    act(() => {
      for (const id of ["a", "b"]) {
        useNekStatusStore
          .getState()
          .consumeEvent("s", { type: "nek.subagent", payload: record(id, "completed") }, 2_000);
      }
    });
    setNekStatusActions("s", statusActions());
    renderView(<NekSessionStatusSlot sessionKey="s" callbacks={callbacks()} />);
    const section = document.querySelector<HTMLElement>(
      '[data-status-view="subagent-status-section"]',
    );
    if (!section) throw new Error("expected the subagent status section");
    expect(section.querySelector("[data-subagent-ended-count]")?.textContent).toBe("2");
    // 全部结束就没有"全部停止"，也不渲染任何行（保持一行紧凑高度）。
    expect(within(section).queryByRole("button", { name: "全部停止" })).toBeNull();
    expect(document.querySelectorAll('[data-status-view="subagent-row"]')).toHaveLength(0);
  });

  it("slot: todo open-plan and queue retrieve use the pane callbacks and the feed actions", async () => {
    const openPlan = vi.fn();
    const setComposerText = vi.fn();
    const focusComposerAtEnd = vi.fn();
    const clearQueue = vi.fn(async () => ({ steering: ["one"], followUp: [] }));
    act(() => {
      useNekStatusStore.getState().consumeEvent("s", {
        type: "nek.state",
        payload: {
          mode: "plan",
          todos: [{ id: "todo-1", content: "检查状态", status: "pending" }],
          plans: [],
          activePlanPath: "/workspace/PLAN.md",
          subagents: [],
        },
      });
      useNekStatusStore
        .getState()
        .consumeEvent("s", { type: "queue_update", steering: ["one"], followUp: [] });
    });
    setNekStatusActions("s", statusActions({ clearQueue }));
    renderView(
      <NekSessionStatusSlot
        sessionKey="s"
        callbacks={callbacks({
          onOpenPlan: openPlan,
          getComposerText: () => "",
          setComposerText,
          focusComposerAtEnd,
        })}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "查看计划" }));
    });
    expect(openPlan).toHaveBeenCalledWith("/workspace/PLAN.md");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "全部取回到输入框" }));
    });
    await waitFor(() => expect(clearQueue).toHaveBeenCalledTimes(1));
    expect(setComposerText).toHaveBeenCalledWith("one");
    expect(focusComposerAtEnd).toHaveBeenCalledTimes(1);
  });
});
