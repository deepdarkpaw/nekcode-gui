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

  it("S1: card and running bar open the same side preview without raw transcript UI", async () => {
    const stopSubagent = vi.fn(async () => undefined);
    const focusSubagent = vi.fn();
    act(() => {
      useNekStatusStore.getState().consumeEvent("s", {
        type: "nek.subagent",
        payload: record("a", "running"),
      });
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

    // 卡片与运行中条的停止按钮同名，按容器区分：卡片上的停止只停这一条。
    const card = document.querySelector<HTMLElement>('[data-status-view="subagent-card"]');
    if (!card) throw new Error("expected a subagent card");
    const cardScope = within(card);
    await act(async () => {
      fireEvent.click(cardScope.getByRole("button", { name: "停止 子代理 a" }));
    });
    expect(stopSubagent).toHaveBeenCalledWith("a");

    fireEvent.click(cardScope.getByRole("button", { name: "在右侧预览 子代理 a" }));
    await waitFor(() => expect(focusSubagent).toHaveBeenCalledWith("a"));
    expect(screen.queryByRole("button", { name: "查看完整消息" })).toBeNull();
    expect(document.querySelector('[data-status-view="subagent-transcript"]')).toBeNull();
    const bar = document.querySelector<HTMLElement>('[data-status-view="running-subagents-bar"]');
    if (!bar) throw new Error("expected the running subagents bar");
    const focusButton = within(bar).getAllByRole("button")[0];
    if (!focusButton) throw new Error("expected a focus button");
    fireEvent.click(focusButton);
    expect(focusSubagent).toHaveBeenCalledWith("a");
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
