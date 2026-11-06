// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it } from "vitest";
import type { ReasoningRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { buildAssistantWorkRenderItems } from "./conversationAssistantWorkItems.js";
import { buildConversationTurnRenderUnits } from "./conversationTurnRenderUnits.js";
import { ConversationTurnGroup } from "./ConversationTurnGroup.js";

const visibility = { messageStreamShowReasoning: true };
const context = {
  workspacePath: "G:/project",
  theme: "light" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  ...visibility,
};
function wrapper({ children }: PropsWithChildren) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}
const base = (rowId: number) => ({
  rowId,
  turnId: "turn",
  entityId: `row:${rowId}`,
  createdAt: rowId * 1000,
  createdAtSeq: rowId,
});
function tool(rowId: number): ToolCallRow {
  return {
    ...base(rowId),
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName: "ast_grep",
    status: "success",
    inputText: "",
    output: { text: "done" },
  };
}
function reasoning(rowId: number, durationMs?: number): ReasoningRow {
  return {
    ...base(rowId),
    kind: "reasoning",
    text: `thought-${rowId}`,
    state: "complete",
    durationMs,
  };
}
function view(rows: Parameters<typeof buildConversationTurnRenderUnits>[0]) {
  const unit = buildConversationTurnRenderUnits(rows, { sessionPhase: "completedSuccess" })[0]!;
  return <ConversationTurnGroup unit={unit} context={context} />;
}
afterEach(cleanup);

it("merges consecutive thinking without losing text, known durations or row anchors", () => {
  const rows = [reasoning(1, 2000), reasoning(2, 3000), reasoning(3, 4000)];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "reasoningGroup",
    row: { text: "thought-1\n\nthought-2\n\nthought-3", durationMs: 9000 },
  });
  const ui = render(view(rows), { wrapper });
  expect(screen.getAllByText("思考")).toHaveLength(1);
  expect(ui.container.querySelector('[data-row-id="2"]')).toBeTruthy();
  expect(ui.container.querySelector('[data-row-id="3"]')).toBeTruthy();
  fireEvent.click(screen.getByText("思考"));
  expect(screen.getByText(/thought-1/).textContent).toBe("thought-1\n\nthought-2\n\nthought-3");
});

it("keeps a manually expanded reasoning block open as consecutive blocks arrive", () => {
  const ui = render(view([reasoning(1)]), { wrapper });
  fireEvent.click(screen.getByText("思考"));
  ui.rerender(view([reasoning(1), reasoning(2)]));
  expect(screen.getByText(/thought-2/)).toBeTruthy();
  ui.rerender(view([reasoning(1), reasoning(2), reasoning(3)]));
  expect(screen.getByText(/thought-3/)).toBeTruthy();
});

it("unknown thinking durations stay unknown and no longer claim a few seconds", () => {
  const rows = [reasoning(1, 2000), reasoning(2)];
  const item = buildAssistantWorkRenderItems(rows, visibility)[0];
  expect(item?.kind === "reasoningGroup" && item.row.durationMs).toBeUndefined();
  render(view(rows), { wrapper });
  expect(screen.queryByText(/持续了/)).toBeNull();
});

it("thinking merge stops at tools, interruption and turn boundaries; hidden reasoning remains hidden", () => {
  const rows = [
    reasoning(1),
    reasoning(2),
    tool(3),
    reasoning(4),
    { ...reasoning(5), state: "interrupted" as const },
    { ...reasoning(6), turnId: "another-turn" },
  ];
  expect(buildAssistantWorkRenderItems(rows, visibility).map((item) => item.kind)).toEqual([
    "reasoningGroup",
    "row",
    "row",
    "row",
    "row",
  ]);
  expect(
    buildAssistantWorkRenderItems(rows, { messageStreamShowReasoning: false }).map(
      (item) => item.kind,
    ),
  ).toEqual(["row"]);
  const stream = buildAssistantWorkRenderItems(
    [reasoning(1), { ...reasoning(2), state: "streaming" }],
    visibility,
  )[0];
  expect(stream).toMatchObject({
    kind: "reasoningGroup",
    row: { state: "streaming" },
    key: "row:1",
  });
});
