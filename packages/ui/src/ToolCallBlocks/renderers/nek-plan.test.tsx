// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";

afterEach(cleanup);
function show(node: TaskChatToolCallTreeNode, open = vi.fn()) {
  return render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ToolCallBlock toolCallNode={node} workspacePath="G:/project" onOpenPlanDetail={open} />
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

it("P4: mode-switch notices cannot render a plan card or plan details button", () => {
  const call = {
    toolId: "mode",
    toolName: "switch_mode",
    kind: "switch_mode",
    status: "completed",
    input: { target_mode_id: "plan" },
    output: "User declined the mode switch. Stay in Agent mode.",
  };
  expect(resolveToolCallIdentity(call).family).not.toBe("switch-mode");
  show({ toolCall: call, childToolCalls: [] });
  expect(screen.queryByRole("button", { name: "查看完整计划" })).toBeNull();
});

it("P4: a real nek plan opens the standard right pane with its complete markdown and Windows path", () => {
  const open = vi.fn();
  const markdown = "# Actual plan\n\n1. Inspect source\n2. Implement";
  const path = "G:/project/.nek/plans/feature.plan.md";
  show(
    {
      toolCall: {
        toolId: "plan-r2",
        toolName: "nek.plan",
        kind: "nek.plan",
        status: "completed",
        input: { plan: markdown, planFilePath: path },
      },
      childToolCalls: [],
    },
    open,
  );
  fireEvent.click(screen.getByRole("button", { name: "查看完整计划" }));
  expect(open).toHaveBeenCalledWith({ toolCallId: "plan-r2", markdown, planFilePath: path });
});
