import { describe, expect, it, vi } from "vitest";
import {
  createNekPaneStatusCallbacks,
  type NekPaneStatusCallbackSources,
} from "./paneStatusCallbacks.js";

function sources(
  overrides: Partial<NekPaneStatusCallbackSources> = {},
): NekPaneStatusCallbackSources {
  return {
    stopSubagent: vi.fn(async () => undefined),
    fetchTranscript: vi.fn(async () => ({ messages: [] })),
    focusSubagent: vi.fn(),
    openPlan: vi.fn(),
    jumpToTodo: vi.fn(),
    canJumpToTodo: () => true,
    getComposerText: () => "",
    setComposerText: vi.fn(),
    focusComposerAtEnd: vi.fn(),
    ...overrides,
  };
}

describe("createNekPaneStatusCallbacks", () => {
  it("routes every pane action to its pane implementation", async () => {
    const pane = sources();
    const callbacks = createNekPaneStatusCallbacks(pane);

    await callbacks.onStopSubagent("subagent-1");
    expect(pane.stopSubagent).toHaveBeenCalledWith("subagent-1");

    await expect(callbacks.fetchTranscript("subagent-1")).resolves.toEqual({ messages: [] });
    expect(pane.fetchTranscript).toHaveBeenCalledWith("subagent-1");

    callbacks.onFocusSubagent("subagent-1");
    expect(pane.focusSubagent).toHaveBeenCalledWith("subagent-1");

    expect(callbacks.onOpenPlan("/workspace/PLAN.md")).toBeUndefined();
    expect(pane.openPlan).toHaveBeenCalledWith("/workspace/PLAN.md");

    callbacks.onJumpToTodo("todo-1");
    expect(pane.jumpToTodo).toHaveBeenCalledWith("todo-1");
    expect(callbacks.canJumpToTodo("todo-1")).toBe(true);

    callbacks.setComposerText("queued text");
    expect(pane.setComposerText).toHaveBeenCalledWith("queued text");
    expect(callbacks.getComposerText()).toBe("");
    callbacks.focusComposerAtEnd();
    expect(pane.focusComposerAtEnd).toHaveBeenCalledTimes(1);
  });

  it("stops a failing subagent visibly instead of swallowing the rejection", async () => {
    const pane = sources({
      stopSubagent: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    });
    const callbacks = createNekPaneStatusCallbacks(pane);

    await expect(callbacks.onStopSubagent("subagent-1")).rejects.toThrow("stop failed");
  });
});
