// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared";
import type {
  ConversationRow,
  SubagentRow,
  ToolCallRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { buildAssistantWorkRenderItems } from "./conversationAssistantWorkItems.js";
import { buildConversationTurnRenderUnits } from "./conversationTurnRenderUnits.js";
import { ConversationTurnGroup } from "./ConversationTurnGroup.js";

function wrapper({ children }: PropsWithChildren) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}
const base = (rowId: number, turnId = "first") => ({
  rowId,
  turnId,
  entityId: `row:${rowId}`,
  createdAt: rowId * 1000,
  createdAtSeq: rowId,
});
const header = (rowId: number, turnId: string, state: TurnHeaderRow["state"]): TurnHeaderRow => ({
  ...base(rowId, turnId),
  kind: "turnHeader",
  origin: "userInput",
  state,
  startedAt: rowId * 1000,
});
const spawn: ToolCallRow = {
  ...base(3),
  kind: "toolCall",
  toolCallId: "spawn",
  toolName: "subagent",
  status: "success",
  inputText: "",
  input: { description: "Inspect the workflow", subagent_type: "worker", run_in_background: true },
  output: { text: "## Verification\n\n**Committed** `abc123`\n".repeat(100) },
};
const child: SubagentRow = {
  ...base(4),
  kind: "subagent",
  parentToolCallId: "spawn",
  childSessionId: "child",
  subagentType: "worker",
  status: "success",
  summaryText: "Inspect the workflow",
  backgrounded: true,
};
const context = {
  workspacePath: "G:/project",
  sessionId: "parent",
  theme: "dark" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  messageStreamShowReasoning: true,
};
const renderRows = (rows: ConversationRow[], onOpenSubagentSession = vi.fn()) => {
  const units = buildConversationTurnRenderUnits(rows, { sessionPhase: "running", nowMs: 10000 });
  return {
    ...render(
      <>
        {units.map((unit) => (
          <ConversationTurnGroup
            key={unit.key}
            unit={unit}
            context={{ ...context, onOpenSubagentSession }}
          />
        ))}
      </>,
      { wrapper },
    ),
    onOpenSubagentSession,
    units,
  };
};
afterEach(cleanup);

it.each([undefined, "generalPurpose"])(
  "resume displays the result's worker type instead of omitted/conflicting input (%s)",
  (requestedType) => {
    const resumed: ToolCallRow = {
      ...spawn,
      ...base(8, "second"),
      toolCallId: "resume-call",
      input: { description: "Continue workflow", resume: "child", subagent_type: requestedType },
      output: {
        text: "Started subagent child",
        display: {
          kind: "subagent_identity",
          id: "child",
          type: "preset-worker",
          model: "test/reasoner",
        },
      },
    };
    // The original spawn and child may be outside the tail window. This row must be self-contained.
    const { container } = renderRows([header(6, "second", "running"), resumed]);
    expect(container.textContent).toContain("preset-worker");
    expect(container.textContent).not.toContain("general-purpose");
    expect(container.textContent).not.toContain("generalPurpose");
  },
);

it("resume awaiting its runtime identity never invents a default type", () => {
  const resumed: ToolCallRow = {
    ...spawn,
    toolCallId: "resume-call",
    status: "running",
    input: { description: "Continue workflow", resume: "child" },
    output: undefined,
  };
  const { container } = renderRows([header(1, "first", "running"), resumed]);
  expect(container.textContent).toContain("Continue workflow");
  expect(container.textContent).not.toContain("general-purpose");
  expect(container.textContent).not.toContain("explorer");
});

it("a new nek subagent without a requested type uses nek's explorer default", () => {
  const { container } = renderRows([
    header(1, "first", "running"),
    { ...spawn, status: "running", input: { description: "Explore files" }, output: undefined },
  ]);
  expect(container.textContent).toContain("explorer");
  expect(container.textContent).not.toContain("general-purpose");
});

it("ST-4: a completed child stays paired with its original spawn and never dumps its Markdown report", () => {
  const items = buildAssistantWorkRenderItems([spawn, child], context);
  expect(items.map((item) => item.kind)).toEqual(["agentToolCall"]);
  const { container, onOpenSubagentSession } = renderRows([
    header(1, "first", "completedSuccess"),
    spawn,
    child,
  ]);
  expect(container.textContent).toContain("Inspect the workflow");
  expect(container.textContent).not.toContain("## Verification");
  expect(container.textContent).not.toContain("abc123");
  expect(container.querySelectorAll('[data-row-id="4"]')).toHaveLength(0);
  fireEvent.click(screen.getByTestId(testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, "child")));
  expect(onOpenSubagentSession).toHaveBeenCalledWith({
    rootSessionId: "parent",
    parentSessionId: "parent",
    childSessionId: "child",
    subagentType: "worker",
    title: "Inspect the workflow",
  });
});

it("ST-4: a child whose spawn is outside the window uses the same compact, clickable agent summary", () => {
  const { container, onOpenSubagentSession } = renderRows([
    header(1, "first", "completedSuccess"),
    child,
  ]);
  expect(container.textContent).toContain("Inspect the workflow");
  expect(container.textContent).not.toContain("worker · success");
  expect(container.querySelectorAll('[data-row-id="4"]')).toHaveLength(1);
  fireEvent.click(screen.getByTestId(testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, "child")));
  expect(onOpenSubagentSession.mock.calls[0]?.[0].childSessionId).toBe("child");
});

it("ST-1: a new user input remains before all resumed work and the next wait in the mounted conversation", () => {
  const rows: ConversationRow[] = [
    header(1, "first", "completedSuccess"),
    { ...base(2), kind: "userInput", origin: "realUser", text: "delegate" },
    spawn,
    child,
    {
      ...base(5),
      kind: "toolCall",
      toolCallId: "wait-1",
      toolName: "await",
      status: "success",
      inputText: "",
    },
    header(6, "second", "running"),
    { ...base(7, "second"), kind: "userInput", origin: "realUser", text: "reply pua" },
    {
      ...base(8, "second"),
      kind: "reasoning",
      text: "responding to the new input",
      state: "complete",
    },
    {
      ...base(9, "second"),
      kind: "toolCall",
      toolCallId: "command",
      toolName: "powershell",
      status: "success",
      inputText: "",
      input: { command: "Write-Output pua" },
    },
    {
      ...base(10, "second"),
      kind: "toolCall",
      toolCallId: "wait-2",
      toolName: "await",
      status: "running",
      inputText: "",
    },
  ];
  const { container, units } = renderRows(rows);
  expect(units).toHaveLength(2);
  expect(units[0]?.isRunning).toBe(false);
  const row = (id: number) => container.querySelector(`[data-row-id="${id}"]`)!;
  expect(row(5).compareDocumentPosition(row(7)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row(7).compareDocumentPosition(row(8)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row(7).compareDocumentPosition(row(9)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row(7).compareDocumentPosition(row(10)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // The child result only changes its spawn summary, not the new turn's content or work clock.
  expect(units[1]?.assistantWorkRows.some((row) => row.kind === "subagent")).toBe(false);
});
