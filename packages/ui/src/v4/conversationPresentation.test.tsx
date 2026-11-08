// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it } from "vitest";
import type {
  ConversationRow,
  ReasoningRow,
  TimelineMarkerPayload,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { buildAssistantWorkRenderItems } from "./conversationAssistantWorkItems.js";
import { buildConversationTurnRenderUnits } from "./conversationTurnRenderUnits.js";
import { ConversationTurnGroup } from "./ConversationTurnGroup.js";
import { buildFileChangeGroup } from "@/ToolCallBlocks/fileChangeGroup.js";
import { toolCallRowToLegacyNode } from "./toolCallRowAdapter.js";
import { ConversationShareReadonlyTimeline } from "./ConversationShareReadonlyTimeline.js";

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

/** provider 在连续 tool call 之间下发的空白正文占位（可见性为零，但仍然是协议行）。 */
function blankStreamedText(rowId: number, text = "") {
  return { ...assistantTextRow(rowId), text, state: "streaming" as const };
}

/** 真实主轮 flow：turnHeader + userInput 在前，工具行按投影顺序跟在后面。 */
function mainTurnRows(
  start: number,
  workRows: readonly ConversationRow[],
  running = false,
): ConversationRow[] {
  const header: TurnHeaderRow = {
    ...base(start),
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: running ? "running" : "completedSuccess",
    startedAt: start * 1000,
    ...(running ? {} : { endedAt: start * 1000 + 500 }),
  };
  const user: UserInputRow = {
    ...base(start + 1),
    kind: "userInput",
    text: "Update queued-input",
    attachments: [],
    origin: "realUser",
  };
  return [header, user, ...workRows];
}

it.each(["", " \n\t"])(
  "CLI-R1: blank assistant blocks (%j) do not split main-turn edits",
  (text) => {
    const start = 10_000 + text.length * 100;
    const rows = [
      edit(start),
      { ...assistantTextRow(start + 1), text },
      edit(start + 2),
      { ...assistantTextRow(start + 3), text },
      edit(start + 4),
    ];
    const items = buildAssistantWorkRenderItems(rows, visibility);
    expect(items.map((item) => item.kind)).toEqual(["changesGroup"]);
    const units = buildConversationTurnRenderUnits(
      [
        { ...base(0), kind: "userInput", text: "Update PRD", attachments: [], origin: "realUser" },
        ...rows,
      ],
      { sessionPhase: "completedSuccess" },
    );
    expect(units[0]!.assistantWorkRows.map((row) => row.rowId)).toEqual([
      start,
      start + 2,
      start + 4,
    ]);
    const ui = render(<ConversationTurnGroup unit={units[0]!} context={context} />, { wrapper });
    expect(screen.getAllByText("PRD.md")).toHaveLength(1);
    expect(screen.getByLabelText("+3")).toBeTruthy();
    fireEvent.click(screen.getByText("PRD.md"));
    expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(1);
  },
);

it("CLI-R2: inputText-only reads separated by empty streamed text share one file summary", () => {
  const first = {
    ...readTool(10),
    input: undefined,
    inputText: JSON.stringify({ path: "/project/PRD.md", offset: 1, limit: 10 }),
  };
  const second = {
    ...readTool(12),
    input: undefined,
    inputText: JSON.stringify({ path: "/project/PRD.md", offset: 11, limit: 10 }),
  };
  const rows = [first, { ...assistantTextRow(11), text: "", state: "streaming" as const }, second];
  expect(buildAssistantWorkRenderItems(rows, visibility).map((item) => item.kind)).toEqual([
    "readGroup",
  ]);
  render(view(rows), { wrapper });
  expect(screen.getAllByText("读取")).toHaveLength(1);
  fireEvent.click(screen.getByText("读取"));
  expect(screen.getAllByText("PRD.md").length).toBeGreaterThan(0);
});

it("CLI-R3: a live main turn keeps one changes container as blank text and new calls stream in", () => {
  const work = [
    edit(20_000),
    blankStreamedText(20_001),
    edit(20_002),
    blankStreamedText(20_003),
    edit(20_004),
  ];
  const units = buildConversationTurnRenderUnits(mainTurnRows(20_100, work, true), {
    nowMs: 20_200_000,
  });
  expect(units).toHaveLength(1);
  const unit = units[0]!;
  expect(unit.isRunning).toBe(true);
  expect(unit.workSegments).toHaveLength(1);
  expect(unit.assistantWorkRows.map((row) => row.rowId)).toEqual([20_000, 20_002, 20_004]);

  const items = buildAssistantWorkRenderItems(unit.assistantWorkRows, visibility, {
    stageTailIsRunning: true,
  });
  expect(items.map((item) => item.kind)).toEqual(["changesGroup"]);
  const group = items[0]!;
  expect(group.key).toBe("changes:20000");
  expect(group.kind === "changesGroup" && group.node.toolCall.status).toBe("in_progress");
  const children = group.kind === "changesGroup" ? group.node.childToolCalls : [];
  // 每条调用只进容器一次，统计也只按一次成功计入。
  expect(children).toHaveLength(3);
  expect(buildFileChangeGroup(children, "/project").totals).toMatchObject({
    completed: 3,
    added: 3,
    removed: 3,
  });

  const ui = render(<ConversationTurnGroup unit={unit} context={context} />, { wrapper });
  expect(screen.getAllByText("PRD.md")).toHaveLength(1);
  expect(screen.getByLabelText("+3")).toBeTruthy();
  // 可见行仍带 row anchor，且协议行对象不被改写（聚合只做展示层）。
  expect(ui.container.querySelector('[data-row-id="20000"]')).toBeTruthy();
  expect(unit.assistantWorkRows[0]).toBe(work[0]);
  fireEvent.click(screen.getByText("PRD.md"));
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(1);

  // 实时增量：再来一条编辑 + 空白占位，首个子调用的 key 必须不变。
  const grown = buildConversationTurnRenderUnits(
    mainTurnRows(20_100, [...work, blankStreamedText(20_005), edit(20_006)], true),
    { nowMs: 20_200_000 },
  );
  expect(
    buildAssistantWorkRenderItems(grown[0]!.assistantWorkRows, visibility, {
      stageTailIsRunning: true,
    }).map((item) => item.key),
  ).toEqual(["changes:20000"]);
  ui.rerender(<ConversationTurnGroup unit={grown[0]!} context={context} />);
  expect(ui.container.querySelectorAll("[data-changes-group]")).toHaveLength(1);
  // 同一 first-call identity：用户展开的状态随新调用保留，没有被重建成收起壳。
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(1);
  expect(ui.container.textContent).toContain("累计 4 次成功操作");
});

it("CLI-R4: blank text that later gains a body re-splits without losing the first-call key", () => {
  const before = [
    edit(21_000),
    edit(21_002),
    blankStreamedText(21_003),
    edit(21_004),
    edit(21_006),
  ];
  expect(buildAssistantWorkRenderItems(before, visibility).map((item) => item.key)).toEqual([
    "changes:21000",
  ]);
  const unit = buildConversationTurnRenderUnits(mainTurnRows(21_100, before, true), {
    nowMs: 21_200_000,
  })[0]!;
  const ui = render(<ConversationTurnGroup unit={unit} context={context} />, { wrapper });
  fireEvent.click(screen.getByText("PRD.md"));
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(1);

  // 同一行后来真的有正文：它现在是真的可见边界，聚合必须重新切段。
  const after = [
    edit(21_000),
    edit(21_002),
    { ...assistantTextRow(21_003), text: "now a real note" },
    edit(21_004),
    edit(21_006),
  ];
  const items = buildAssistantWorkRenderItems(after, visibility);
  expect(items.map((item) => item.kind)).toEqual(["changesGroup", "row", "changesGroup"]);
  expect(items.map((item) => item.key)).toEqual(["changes:21000", "row:21003", "changes:21004"]);
  const grown = buildConversationTurnRenderUnits(mainTurnRows(21_100, after, true), {
    nowMs: 21_200_000,
  })[0]!;
  ui.rerender(<ConversationTurnGroup unit={grown} context={context} />);
  expect(ui.container.textContent).toContain("now a real note");
  expect(ui.container.querySelectorAll("[data-changes-group]")).toHaveLength(2);
  // 首组 key 未变，展开状态保留；新出现的第二组仍是默认收起。
  expect(ui.container.querySelectorAll("[data-change-file]")).toHaveLength(1);
});

it("CLI-R5: completed main turn hides blank blocks while keeping the real reply", () => {
  const withReply = buildConversationTurnRenderUnits(
    mainTurnRows(22_100, [
      edit(22_000),
      { ...assistantTextRow(22_001), text: "" },
      edit(22_002),
      { ...assistantTextRow(22_003), text: "Done" },
    ]),
    { sessionPhase: "completedSuccess" },
  )[0]!;
  expect(withReply.latestAssistantTextRow?.rowId).toBe(22_003);
  expect(withReply.assistantWorkRows.map((row) => row.rowId)).toEqual([22_000, 22_002, 22_003]);
  expect(withReply.renderRows.some((row) => row.rowId === 22_001)).toBe(false);
  const ui = render(<ConversationTurnGroup unit={withReply} context={context} />, { wrapper });
  expect(ui.container.textContent).toContain("Done");
  expect(ui.container.querySelector('[data-row-id="22001"]')).toBeNull();

  // 历史完成态：最后一次可见内容是工具行时「已工作」默认展开，空占位不制造空洞。
  cleanup();
  const toolTail = buildConversationTurnRenderUnits(
    mainTurnRows(22_200, [
      edit(22_010),
      { ...assistantTextRow(22_011), text: " \n\t" },
      edit(22_012),
    ]),
    { sessionPhase: "completedSuccess" },
  )[0]!;
  expect(toolTail.assistantWorkRows.map((row) => row.rowId)).toEqual([22_010, 22_012]);
  const tailUi = render(<ConversationTurnGroup unit={toolTail} context={context} />, { wrapper });
  expect(screen.getAllByText("PRD.md")).toHaveLength(1);
  expect(screen.getByLabelText("+2")).toBeTruthy();
  expect(tailUi.container.querySelector('[data-row-id="22011"]')).toBeNull();
});

it("CLI-R6: inputText-only reads keep offset/limit and merge streamed partial arguments", () => {
  const complete = {
    ...readTool(23_000),
    input: undefined,
    inputText: JSON.stringify({ path: "/project/PRD.md", offset: 1, limit: 40 }),
  };
  const second = {
    ...readTool(23_002),
    input: undefined,
    inputText: JSON.stringify({ path: "/project/PRD.md", offset: 41, limit: 40 }),
  };
  // 流式半截 JSON：只解析出 path，仍必须与同文件读取聚合，而不是退化成两条孤立行。
  const partial = {
    ...readTool(23_004),
    input: undefined,
    status: "inputStreaming" as const,
    inputText: '{"path": "/project/PRD.md", "offset": 81, "limit": 40',
  };
  const work = [complete, blankStreamedText(23_001), second, blankStreamedText(23_003), partial];
  const unit = buildConversationTurnRenderUnits(mainTurnRows(23_100, work, true), {
    nowMs: 23_200_000,
  })[0]!;

  const items = buildAssistantWorkRenderItems(unit.assistantWorkRows, visibility, {
    stageTailIsRunning: true,
  });
  expect(items.map((item) => item.kind)).toEqual(["readGroup"]);
  const group = items[0]!;
  expect(group.kind === "readGroup" && group.rows.map((row) => row.rowId)).toEqual([
    23_000, 23_002, 23_004,
  ]);
  expect(group.kind === "readGroup" && group.node.toolCall.input).toEqual({
    path: "/project/PRD.md",
  });
  const children = group.kind === "readGroup" ? group.node.childToolCalls : [];
  expect(children.map((child) => child.toolCall.input)).toEqual([
    { path: "/project/PRD.md", offset: 1, limit: 40 },
    { path: "/project/PRD.md", offset: 41, limit: 40 },
    { path: "/project/PRD.md" },
  ]);
  // 协议行不被改写：原始 inputText（含 offset/limit）仍留在 row 上。
  expect(group.kind === "readGroup" && group.rows.map((row) => row.inputText)).toEqual([
    complete.inputText,
    second.inputText,
    partial.inputText,
  ]);

  const ui = render(<ConversationTurnGroup unit={unit} context={context} />, { wrapper });
  expect(screen.getAllByText("读取")).toHaveLength(1);
  fireEvent.click(screen.getByText("读取"));
  expect(ui.container.querySelectorAll("[data-read-group] [data-tool-call-id]")).toHaveLength(3);
});

it("CLI-R6b: a lone inputText-only read still resolves its file", () => {
  const unit = buildConversationTurnRenderUnits(
    mainTurnRows(23_300, [
      {
        ...readTool(23_400),
        input: undefined,
        inputText: JSON.stringify({ path: "/project/ARD.md", offset: 5, limit: 20 }),
      },
    ]),
    { sessionPhase: "completedSuccess" },
  )[0]!;
  render(<ConversationTurnGroup unit={unit} context={context} />, { wrapper });
  expect(screen.getByText("ARD.md")).toBeTruthy();
});

it("CLI-R7: blank placeholders never merge work across visible thinking or real text", () => {
  const acrossThinking = buildAssistantWorkRenderItems(
    [
      edit(24_000),
      blankStreamedText(24_001),
      reasoning(24_002),
      blankStreamedText(24_003),
      edit(24_004),
    ],
    visibility,
  );
  expect(acrossThinking.map((item) => item.kind)).toEqual(["row", "row", "row"]);
  expect(toolCallItemIds(acrossThinking)).toEqual(["edit-24000", "edit-24004"]);

  const acrossText = buildAssistantWorkRenderItems(
    [edit(24_010), blankStreamedText(24_011), assistantTextRow(24_012), edit(24_013)],
    visibility,
  );
  expect(toolCallItemIds(acrossText)).toEqual(["edit-24010", "edit-24013"]);
  expect(acrossText.every((item) => item.kind !== "changesGroup")).toBe(true);

  // 空的 thinking 块同样是不可见占位：它不能切断写聚合，也不能渲染成空「思考」项。
  const emptyThinking = buildAssistantWorkRenderItems(
    [edit(24_020), { ...reasoning(24_021), text: "  " }, edit(24_022)],
    visibility,
  );
  expect(emptyThinking.map((item) => item.kind)).toEqual(["changesGroup"]);
  expect(toolCallItemIds(emptyThinking)).toEqual([]);
});

it("CLI-R8: readonly share and child-session turns reuse the same grouping entry", () => {
  // 只读分享入口的调用形状（ReadonlyAssistantWorkItems）：正文/思考常显、不做改动聚合。
  const shareRows = [
    {
      ...readTool(25_000),
      input: undefined,
      inputText: JSON.stringify({ path: "/project/PRD.md" }),
    },
    blankStreamedText(25_001),
    {
      ...readTool(25_002),
      input: undefined,
      inputText: JSON.stringify({ path: "/project/PRD.md" }),
    },
  ];
  expect(
    buildAssistantWorkRenderItems(
      shareRows,
      { messageStreamShowReasoning: true },
      {
        stageTailIsRunning: true,
        enableExploreGrouping: true,
        enableTerminalGrouping: true,
        enableChangesGrouping: false,
      },
    ).map((item) => item.kind),
  ).toEqual(["readGroup"]);

  // 子会话/侧边会话走同一个 ConversationTimeline + render unit：turnId 不影响聚合语义。
  const childRows = mainTurnRows(25_300, [
    edit(25_100),
    blankStreamedText(25_101),
    edit(25_102),
  ]).map((row) => ({ ...row, turnId: "child-session" }));
  const childUnit = buildConversationTurnRenderUnits(childRows, {
    sessionPhase: "completedSuccess",
  })[0]!;
  expect(childUnit.assistantWorkRows.map((row) => row.rowId)).toEqual([25_100, 25_102]);
  expect(
    buildAssistantWorkRenderItems(childUnit.assistantWorkRows, visibility).map((item) => item.key),
  ).toEqual(["changes:25100"]);
  render(<ConversationTurnGroup unit={childUnit} context={context} />, { wrapper });
  expect(screen.getAllByText("PRD.md")).toHaveLength(1);
  expect(screen.getByLabelText("+2")).toBeTruthy();
});

it("CLI-R8b: the readonly share timeline renders one read group for blank-separated reads", () => {
  const readRow = (rowId: number) => ({
    ...readTool(rowId),
    input: undefined,
    inputText: JSON.stringify({ path: "/project/PRD.md", offset: rowId, limit: 10 }),
  });
  const rows: ConversationRow[] = [
    {
      ...base(40_000),
      kind: "userInput",
      text: "show the file",
      attachments: [],
      origin: "realUser",
    },
    readRow(40_001),
    { ...assistantTextRow(40_002), text: "", state: "complete" as const },
    readRow(40_003),
  ];
  render(
    <ConversationShareReadonlyTimeline rows={rows} locale="zh-CN" workspacePath="/project" />,
    {
      wrapper,
    },
  );
  expect(
    document.querySelectorAll('[data-conversation-share-work-group="readGroup"]'),
  ).toHaveLength(1);
  expect(screen.getAllByText("读取")).toHaveLength(1);
  fireEvent.click(screen.getByText("读取"));
  expect(
    document.querySelectorAll(
      '[data-conversation-share-work-group="readGroup"] [data-conversation-share-row-kind="toolCall"]',
    ),
  ).toHaveLength(2);
});

it("CLI-R9: one container counts mixed statuses once, and only successes as success", () => {
  const rows = [
    edit(26_000),
    blankStreamedText(26_001),
    edit(26_002, "error"),
    edit(26_003, "cancelled"),
    edit(26_004, "running"),
  ];
  const items = buildAssistantWorkRenderItems(rows, visibility, { stageTailIsRunning: true });
  expect(items.map((item) => item.kind)).toEqual(["changesGroup"]);
  const group = items[0]!;
  const children = group.kind === "changesGroup" ? group.node.childToolCalls : [];
  // 每条调用只进容器一次，空白占位不产生第 5 条。
  expect(children.map((child) => child.toolCall.toolId)).toEqual([
    "edit-26000",
    "edit-26002",
    "edit-26003",
    "edit-26004",
  ]);
  expect(buildFileChangeGroup(children, "/project").totals).toMatchObject({
    completed: 1,
    failed: 1,
    cancelled: 1,
    running: 1,
    added: 1,
    removed: 1,
  });
});

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
