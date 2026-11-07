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

function assistantTextRow(rowId: number) {
  return {
    ...base(rowId),
    kind: "assistantText" as const,
    text: "note",
    state: "complete" as const,
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

/** 只统计「普通行」里承载的工具行，用来断言聚合没有把某条工具藏掉或重复展示。 */
function toolCallItemIds(items: ReturnType<typeof buildAssistantWorkRenderItems>): string[] {
  return items.flatMap((item) =>
    item.kind === "row" && item.row.kind === "toolCall" ? [item.row.toolCallId] : [],
  );
}

it("CG2: text, terminal, plan, interactive tools and turn boundaries still stop write grouping", () => {
  for (const boundary of [
    { ...tool(3), toolName: "bash", input: { command: "pnpm test" } },
    { ...tool(3), toolName: "create_plan" },
    { ...tool(3), toolName: "update_plan" },
    { ...tool(3), toolName: "ask_question" },
    { ...base(3), kind: "assistantText" as const, text: "note", state: "complete" as const },
  ]) {
    const items = buildAssistantWorkRenderItems([edit(1), edit(2), boundary, edit(4), edit(5)], {
      messageStreamShowReasoning: false,
    });
    expect(items.filter((item) => item.kind === "changesGroup")).toHaveLength(2);
  }
  // 单条写操作不建「更改」容器，各自成行。
  expect(
    buildAssistantWorkRenderItems([edit(1), { ...edit(2), turnId: "next" }], visibility),
  ).toHaveLength(2);
});

it("CG2b: markers without UI keep writes adjacent while visible markers split them", () => {
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
      [
        edit(1),
        edit(2),
        marker(3, { type: "compact", origin: "auto", status: "success" }),
        edit(4),
        edit(5),
      ],
      visibility,
    ).filter((item) => item.kind === "changesGroup"),
  ).toHaveLength(2);
});

it("CG2e: relative and absolute reads of one file converge to a single read group", () => {
  const items = buildAssistantWorkRenderItems(
    [readTool(1, "src/main.ts"), readTool(2, "/project/src/main.ts")],
    visibility,
  );
  expect(items.map((item) => item.kind)).toEqual(["readGroup"]);
  const group = items[0]!;
  expect(group.kind === "readGroup" && group.rows.map((row) => row.toolCallId)).toEqual([
    "read-1",
    "read-2",
  ]);
  expect(group.kind === "readGroup" && group.node.toolCall.input).toEqual({ path: "src/main.ts" });
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

it("RD1: adjacent reads of one file collapse into a single read group", () => {
  const rows = [readTool(1), readTool(2), readTool(3)];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items.map((item) => item.kind)).toEqual(["readGroup"]);
  const group = items[0]!;
  expect(group.kind === "readGroup" && group.rows.map((row) => row.toolCallId)).toEqual([
    "read-1",
    "read-2",
    "read-3",
  ]);
  expect(group.key).toBe("reads:1");
  expect(group.kind === "readGroup" && group.node.toolCall.input).toEqual({
    path: "/project/PRD.md",
  });
  // 没有任何一条读取散落成普通行。
  expect(toolCallItemIds(items)).toEqual([]);
});

it("RD2: different files never merge and a single read keeps its own row", () => {
  const differentFiles = buildAssistantWorkRenderItems(
    [readTool(1), readTool(2, "/project/ARD.md")],
    visibility,
  );
  expect(differentFiles.every((item) => item.kind !== "readGroup")).toBe(true);
  expect(toolCallItemIds(differentFiles)).toEqual(["read-1", "read-2"]);
  expect(
    buildAssistantWorkRenderItems([readTool(1), readTool(2)], visibility).filter(
      (item) => item.kind === "readGroup",
    ),
  ).toHaveLength(1);
});

it("RD2b: searches keep their own Explore group and never swallow adjacent reads", () => {
  const items = buildAssistantWorkRenderItems([grepTool(1), readTool(2), readTool(3)], visibility);
  expect(items.map((item) => item.kind)).toEqual(["row", "readGroup"]);
  expect(toolCallItemIds(items)).toEqual(["grep-1"]);
});

it("RD3: thinking and assistant text break read merging", () => {
  const acrossReasoning = buildAssistantWorkRenderItems(
    [readTool(1), reasoning(2), readTool(3)],
    visibility,
  );
  expect(toolCallItemIds(acrossReasoning)).toEqual(["read-1", "read-3"]);
  expect(acrossReasoning.every((item) => item.kind !== "readGroup")).toBe(true);

  const acrossText = buildAssistantWorkRenderItems(
    [readTool(1), assistantTextRow(2), readTool(3)],
    visibility,
  );
  expect(toolCallItemIds(acrossText)).toEqual(["read-1", "read-3"]);
  expect(acrossText.every((item) => item.kind !== "readGroup")).toBe(true);
});

it("RD4: adjacent writes of one file form one changes group", () => {
  const rows = [edit(1), edit(2)];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items.map((item) => item.kind)).toEqual(["changesGroup"]);
  const group = buildFileChangeGroup(rows.map(toolCallRowToLegacyNode), "/project");
  expect(group.files).toHaveLength(1);
  expect(group.totals).toMatchObject({ completed: 2, added: 2, removed: 2, unknown: 0 });
  // reads 统计字段已被删除：读取永远不进入更改组。
  expect(group.files[0]?.stats).not.toHaveProperty("reads");
});

it("RD5: a single write keeps its own row and thinking splits writes", () => {
  expect(buildAssistantWorkRenderItems([edit(1)], visibility).map((item) => item.kind)).toEqual([
    "row",
  ]);
  const acrossReasoning = buildAssistantWorkRenderItems(
    [edit(1), reasoning(2), edit(3)],
    visibility,
  );
  expect(toolCallItemIds(acrossReasoning)).toEqual(["edit-1", "edit-3"]);
  expect(acrossReasoning.every((item) => item.kind !== "changesGroup")).toBe(true);
});

it("RD6: one changes group carries every adjacent write per file", () => {
  const rows = [edit(1), edit(2, "success", "/project/ARD.md"), edit(3)];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items.map((item) => item.kind)).toEqual(["changesGroup"]);
  const group = items[0]!;
  const fileGroup = buildFileChangeGroup(
    group.kind === "changesGroup" ? group.rows.map(toolCallRowToLegacyNode) : [],
    "/project",
  );
  expect(fileGroup.files).toHaveLength(2);
  expect(fileGroup.files.map((file) => file.calls.length)).toEqual([2, 1]);
  expect(fileGroup.totals.completed).toBe(3);
});

it("RD7: reads and writes of one file never fuse", () => {
  const rows = [readTool(1), edit(2), readTool(3), edit(4)];
  const items = buildAssistantWorkRenderItems(rows, visibility);
  expect(items).toHaveLength(4);
  expect(items.every((item) => item.kind === "row")).toBe(true);
  expect(toolCallItemIds(items)).toEqual(["read-1", "edit-2", "read-3", "edit-4"]);
});

it("RD8: repeated reads show one summary and the changes hint is gone", () => {
  const ui = render(view([readTool(1), readTool(2), readTool(3)]), { wrapper });
  expect(screen.getAllByText("读取")).toHaveLength(1);
  fireEvent.click(screen.getByText("读取"));
  expect(ui.container.querySelectorAll("[data-read-group] [data-tool-call-id]")).toHaveLength(3);

  const changes = render(view([edit(11), edit(12)]), { wrapper });
  fireEvent.click(screen.getByText("更改"));
  expect(changes.container.textContent).not.toContain("不是最终净差异");
  expect(changes.container.textContent).not.toContain("展开文件可查看逐次操作");
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
