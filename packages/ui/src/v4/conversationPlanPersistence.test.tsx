// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandAck, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useNekInteractionStore } from "@/nek/interactions/interactionStore.js";
import { useNekPlanExecution } from "@/nek/interactions/useNekPlanExecution.js";
import { ConversationRowView } from "./ConversationRowView.js";

const sessionId = "plan-source";
const path = "G:/project/.nek/plans/a.plan.md";
const markdown = "# Review plan\n\nDo not re-run an older revision.";
const ack: CommandAck = {
  commandId: "build",
  status: "accepted",
  revisionAtDecision: 1,
  result: { type: "executeNekPlan", sessionId: "new-plan-session" },
};
const dispatch = vi.fn(async (): Promise<CommandAck> => ack);
const onOpenPlanDetail = vi.fn();
const onOpenSession = vi.fn();

function PlanRows({ current }: { current: string }) {
  const nekPlanExecution = useNekPlanExecution({
    sessionId: current,
    scopeKey: "workspace",
    snapshot: {
      sessionId,
      config: {
        mode: "plan",
        provider: "mock",
        model: "mock",
        thought: "off",
        thoughtLevels: [],
        followupMode: "queue",
        nekReadyPlan: { path, revision: 2 },
      },
      control: {
        phase: "completedSuccess",
        canStop: false,
        sessionEnded: true,
        lastError: null,
        apiRetry: null,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
      },
    },
    readOnly: false,
    dispatch,
    onOpenSession,
  });
  return [1, 2].map((revision) => {
    const row: ToolCallRow = {
      rowId: revision,
      createdAtSeq: revision,
      createdAt: revision,
      entityId: `entry:${revision}:plan`,
      turnId: `turn:${revision}`,
      kind: "toolCall",
      toolCallId: `artifact-${revision}`,
      toolName: "nek.plan",
      status: "success",
      inputText: "",
      input: { plan: markdown, planFilePath: path, revision },
    };
    return (
      <ConversationRowView
        key={revision}
        row={row}
        context={{
          sessionId: current,
          workspacePath: "G:/project",
          theme: "system",
          codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
          onOpenPlanDetail,
          nekPlanExecution,
        }}
      />
    );
  });
}

function pane(current = sessionId) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <PlanRows current={current} />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

afterEach(() => {
  cleanup();
  useNekInteractionStore.getState().disconnect(sessionId);
  vi.clearAllMocks();
});

it("only executes the authoritative ready revision and still opens the older revision in details", async () => {
  render(pane());
  const [oldDetail] = screen.getAllByRole("button", { name: "查看完整计划" });
  fireEvent.click(oldDetail!);
  expect(onOpenPlanDetail).toHaveBeenCalledWith({
    toolCallId: "artifact-1",
    markdown,
    planFilePath: path,
    parentSessionId: sessionId,
  });
  expect(screen.getAllByRole("button", { name: "执行计划" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "在新会话中执行" }));
  await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("new-plan-session"));
  expect(dispatch).toHaveBeenCalledWith(
    "executeNekPlan",
    { path, revision: 2, fresh: true },
    sessionId,
  );
  expect(onOpenPlanDetail).toHaveBeenCalledOnce();
});

it("shows restored actions again after a live approval is removed and the pane switches back", () => {
  const { rerender } = render(pane());
  expect(screen.getByRole("button", { name: "执行计划" })).toBeTruthy();
  act(() => {
    useNekInteractionStore.getState().enqueue(sessionId, {
      type: "extension_ui_request",
      method: "structured",
      kind: "nek.plan_review",
      id: "live",
      payload: {},
    });
  });
  expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
  rerender(pane("another-session"));
  act(() => {
    useNekInteractionStore.getState().cancelById("live", "superseded");
  });
  expect(screen.queryByRole("button", { name: "执行计划" })).toBeNull();
  rerender(pane());
  expect(screen.getByRole("button", { name: "执行计划" })).toBeTruthy();
});
