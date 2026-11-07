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
import { buildFileChangeGroup } from "@/ToolCallBlocks/fileChangeGroup.js";
import { toolCallRowToLegacyNode } from "./toolCallRowAdapter.js";

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

function edit(
  rowId: number,
  status: ToolCallRow["status"] = "success",
  path = "/project/PRD.md",
): ToolCallRow {
  return {
    ...base(rowId),
    kind: "toolCall",
    toolCallId: `edit-${rowId}`,
    toolName: "edit",
    status,
    inputText: "",
    input: { file_path: path, old_string: "a", new_string: "b" },
    output: {
      text: "done",
      display: {
        kind: "file_diff",
        filePath: path,
        additions: 1,
        deletions: 1,
        structuredPatch: [],
      },
    },
  };
}

it("CG1: same-file operation counts are accumulated once, excluding failed/cancelled/running calls", () => {
  const rows = [edit(1), edit(2), edit(3, "error"), edit(4, "cancelled"), edit(5, "running")];
  const group = buildFileChangeGroup(rows.map(toolCallRowToLegacyNode), "/project");
  expect(group.files).toHaveLength(1);
  expect(group.totals).toMatchObject({
    completed: 2,
    failed: 1,
    cancelled: 1,
    running: 1,
    added: 2,
    removed: 2,
  });
  expect(
    buildFileChangeGroup([...rows, rows[0]!].map(toolCallRowToLegacyNode), "/project").totals,
  ).toEqual(group.totals);
});

it("CG2: hidden reasoning, other tools, text and turn boundaries stop write grouping", () => {
  for (const boundary of [
    reasoning(2),
    tool(2),
    { ...tool(2), toolName: "create_plan" },
    { ...tool(2), toolName: "update_plan" },
    { ...base(2), kind: "assistantText" as const, text: "note", state: "complete" as const },
  ]) {
    const items = buildAssistantWorkRenderItems([edit(1), boundary, edit(3)], {
      messageStreamShowReasoning: false,
    });
    expect(items.filter((item) => item.kind === "changesGroup")).toHaveLength(2);
  }
  expect(
    buildAssistantWorkRenderItems([edit(1), { ...edit(2), turnId: "next" }], visibility),
  ).toHaveLength(2);
});

it("CG3: dozens of edits show one collapsed file summary and retain expansion as calls arrive", () => {
  const rows = Array.from({ length: 20 }, (_, i) => edit(i + 100));
  const ui = render(view(rows), { wrapper });
  expect(screen.getAllByText("PRD.md")).toHaveLength(1);
  expect(screen.getByLabelText("+20")).toBeTruthy();
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(0);
  fireEvent.click(screen.getByText("PRD.md"));
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(1);
  ui.rerender(view([...rows, edit(120, "success", "/project/ARD.md")]));
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(2);
  expect(screen.queryByText("工作区 Git 差异")).toBeNull();
});

it("CG4: write without a before-image does not invent a deletion count", () => {
  const row = {
    ...edit(1),
    toolName: "write",
    input: { path: "/project/PRD.md", content: "replacement" },
    output: { text: "written" },
  };
  const group = buildFileChangeGroup([toolCallRowToLegacyNode(row)], "/project");
  expect(group.totals).toMatchObject({ completed: 1, unknown: 1, added: 0, removed: 0 });
  expect(group.files[0]?.summary?.changeStat).toBeUndefined();
});

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
