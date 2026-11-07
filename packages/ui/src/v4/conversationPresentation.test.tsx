// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it } from "vitest";
import type {
  ReasoningRow,
  TimelineMarkerPayload,
  TimelineMarkerRow,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
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

function readTool(
  rowId: number,
  path = "/project/PRD.md",
  status: ToolCallRow["status"] = "success",
): ToolCallRow {
  return {
    ...base(rowId),
    kind: "toolCall",
    toolCallId: `read-${rowId}`,
    toolName: "read",
    status,
    inputText: "",
    input: { file_path: path },
    output: { text: "file content" },
  };
}

function grepTool(rowId: number): ToolCallRow {
  return {
    ...base(rowId),
    kind: "toolCall",
    toolCallId: `grep-${rowId}`,
    toolName: "grep",
    status: "success",
    inputText: "",
    input: { pattern: "PRD" },
    output: { text: "PRD.md:1" },
  };
}

function marker(rowId: number, payload: TimelineMarkerPayload): TimelineMarkerRow {
  return { ...base(rowId), kind: "timelineMarker", marker: payload };
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

it("CG2: text, terminal, plan, interactive tools and turn boundaries still stop write grouping", () => {
  for (const boundary of [
    { ...tool(2), toolName: "bash", input: { command: "pnpm test" } },
    { ...tool(2), toolName: "create_plan" },
    { ...tool(2), toolName: "update_plan" },
    { ...tool(2), toolName: "ask_question" },
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

it("CG2b: reasoning steps and markers without UI never split the same file's writes", () => {
  const rows = [
    reasoning(1),
    edit(2, "success", "/project/PRD.md"),
    reasoning(3),
    edit(4, "success", "/project/PRD.md"),
  ];
  for (const messageStreamShowReasoning of [true, false]) {
    const items = buildAssistantWorkRenderItems(rows, { messageStreamShowReasoning });
    const groups = items.filter((item) => item.kind === "changesGroup");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("changes:2");
    const group = buildFileChangeGroup(groups[0]!.rows.map(toolCallRowToLegacyNode), "/project");
    expect(group.files).toHaveLength(1);
    expect(group.files[0]?.summary?.path).toBe("/project/PRD.md");
    expect(group.totals).toMatchObject({ completed: 2, added: 2, removed: 2, unknown: 0 });
  }

  const withoutUi = [
    edit(1),
    marker(2, { type: "retryNotice", attempt: 1, reasonCode: "rate_limit" }),
    marker(3, { type: "checkpointRestored", checkpointId: "checkpoint-1" }),
    edit(4),
  ];
  const items = buildAssistantWorkRenderItems(withoutUi, visibility);
  expect(items.map((item) => item.kind)).toEqual(["changesGroup"]);
  // 有 UI 的 marker（compact / modelChange）仍然是硬边界。
  expect(
    buildAssistantWorkRenderItems(
      [edit(1), marker(2, { type: "compact", origin: "auto", status: "success" }), edit(3)],
      visibility,
    ).filter((item) => item.kind === "changesGroup"),
  ).toHaveLength(2);
});

it("CG2c: same-file reads join the Changes group across reasoning steps", () => {
  const rows = [
    readTool(1),
    reasoning(2),
    edit(3, "success", "/project/PRD.md"),
    reasoning(4),
    readTool(5),
    edit(6, "success", "/project/PRD.md"),
  ];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items.map((item) => item.kind)).toEqual(["reasoningGroup", "changesGroup"]);
  const groups = items.filter((item) => item.kind === "changesGroup");
  expect(groups).toHaveLength(1);
  expect(groups[0]!.rows.map((row) => row.toolCallId)).toEqual([
    "read-1",
    "edit-3",
    "read-5",
    "edit-6",
  ]);
  const group = buildFileChangeGroup(groups[0]!.rows.map(toolCallRowToLegacyNode), "/project");
  expect(group.files).toHaveLength(1);
  expect(group.files[0]?.calls.map((call) => call.toolCall.toolId)).toEqual([
    "read-1",
    "edit-3",
    "read-5",
    "edit-6",
  ]);
  // 读取不是写操作：不虚报成功次数，也不会因为没有 changeStat 触发“部分操作无增删统计”。
  expect(group.files[0]?.stats).toMatchObject({
    completed: 2,
    reads: 2,
    added: 2,
    removed: 2,
    unknown: 0,
  });
  expect(group.totals).toMatchObject({ completed: 2, added: 2, removed: 2, unknown: 0 });
  expect(items.filter((item) => item.kind === "row")).toHaveLength(0);

  const ui = render(view(rows), { wrapper });
  fireEvent.click(screen.getByText("更改"));
  fireEvent.click(screen.getByText("PRD.md"));
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(1);
  expect(
    [...ui.container.querySelectorAll("[data-change-file] [data-tool-call-id]")].map((node) =>
      node.getAttribute("data-tool-call-id"),
    ),
  ).toEqual(["read-1", "edit-3", "read-5", "edit-6"]);
});

it("CG2d: reads and searches of other files stay in Explore inside the same stage", () => {
  const rows = [
    readTool(1),
    grepTool(2),
    readTool(3, "/project/OTHER.md"),
    edit(4, "success", "/project/PRD.md"),
  ];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items.map((item) => item.kind)).toEqual(["exploreGroup", "changesGroup"]);
  const explore = items.filter((item) => item.kind === "exploreGroup");
  expect(explore[0]!.rows.map((row) => row.toolCallId)).toEqual(["grep-2", "read-3"]);
  const changes = items.filter((item) => item.kind === "changesGroup");
  expect(changes[0]!.rows.map((row) => row.toolCallId)).toEqual(["read-1", "edit-4"]);
});

it("CG2e: relative read paths and absolute edit paths resolve to the same file group", () => {
  const rows = [
    readTool(1, "src/main.ts"),
    edit(2, "success", "/project/src/main.ts"),
    readTool(3, "src/main.ts"),
    edit(4, "success", "/project/src/main.ts"),
  ];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items.map((item) => item.kind)).toEqual(["changesGroup"]);
  const groups = items.filter((item) => item.kind === "changesGroup");
  const group = buildFileChangeGroup(groups[0]!.rows.map(toolCallRowToLegacyNode), "/project");
  expect(group.files).toHaveLength(1);
  expect(group.files[0]?.key).toBe("/project/src/main.ts");
  expect(group.files[0]?.calls).toHaveLength(4);
  expect(group.totals).toMatchObject({ completed: 2, added: 2, removed: 2, unknown: 0 });
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
