// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNekStatusStore } from "./store.js";
import { intlWrapper } from "./controllerTestUtils.js";
import { useTodoPanelController } from "./useTodoPanelController.js";

beforeEach(() => {
  vi.useFakeTimers();
  useNekStatusStore.getState().reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setTodos(
  todos: Array<{
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }>,
  activePlanPath?: string,
) {
  useNekStatusStore.getState().consumeEvent(
    "s",
    {
      type: "nek.state",
      payload: {
        mode: "agent",
        todos,
        plans: [],
        ...(activePlanPath ? { activePlanPath } : {}),
        subagents: [],
      },
    },
    Date.now(),
  );
}

describe("todo panel controller", () => {
  it("TD-1/TD-2/TD-3: preserves order, hides empty state, and excludes cancelled from totals", () => {
    const onJump = vi.fn();
    setTodos([
      { id: "a", content: "A", status: "completed" },
      { id: "b", content: "B", status: "cancelled" },
      { id: "c", content: "C", status: "pending" },
    ]);
    const { result } = renderHook(
      () =>
        useTodoPanelController({
          sessionKey: "s",
          onOpenPlan: vi.fn(),
          onJumpToTodo: onJump,
          canJumpToTodo: (id) => id === "a",
        }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view.visible).toBe(true);
    expect(result.current.view.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result.current.view.summary).toEqual({
      id: "nek.status.todo.summary",
      values: { completed: 1, total: 2 },
    });
    expect(result.current.view.allDone).toBe(false);
    expect(result.current.view.items[0]?.jumpable).toBe(true);
    expect(result.current.view.items[1]?.jumpable).toBe(false);
    result.current.jump("a");
    result.current.jump("b");
    expect(onJump).toHaveBeenCalledTimes(1);
    act(() => setTodos([]));
    expect(result.current.view.visible).toBe(false);
  });

  it("TD-4: defaults open when pending work exists and exposes fold state", () => {
    setTodos([{ id: "a", content: "A", status: "in_progress" }]);
    const { result } = renderHook(
      () =>
        useTodoPanelController({
          sessionKey: "s",
          onOpenPlan: vi.fn(),
          onJumpToTodo: vi.fn(),
          canJumpToTodo: () => false,
        }),
      { wrapper: intlWrapper },
    );
    expect(result.current.view.fold.id).toBe("todos:s");
    expect(result.current.view.fold.open).toBe(true);
    act(() => result.current.view.fold.onOpenChange(false));
    expect(result.current.view.fold.open).toBe(false);
  });

  it("TD-5: marks changed todos for 1.5 seconds", () => {
    setTodos([{ id: "a", content: "A", status: "pending" }]);
    const { result } = renderHook(
      () =>
        useTodoPanelController({
          sessionKey: "s",
          onOpenPlan: vi.fn(),
          onJumpToTodo: vi.fn(),
          canJumpToTodo: () => false,
        }),
      { wrapper: intlWrapper },
    );
    act(() => setTodos([{ id: "a", content: "A", status: "completed" }]));
    expect(result.current.view.recentlyChanged).toEqual(["a"]);
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current.view.recentlyChanged).toEqual([]);
  });

  it("TD-7: exposes openPlan only with an active plan", async () => {
    const onOpenPlan = vi.fn().mockResolvedValue(undefined);
    setTodos([{ id: "a", content: "A", status: "completed" }], "plan.md");
    const { result } = renderHook(
      () =>
        useTodoPanelController({
          sessionKey: "s",
          onOpenPlan,
          onJumpToTodo: vi.fn(),
          canJumpToTodo: () => false,
        }),
      { wrapper: intlWrapper },
    );
    await act(async () => await result.current.actions.openPlan.run());
    expect(onOpenPlan).toHaveBeenCalledWith("plan.md");
  });
});
