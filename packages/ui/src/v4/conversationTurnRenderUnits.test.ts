import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  SessionPhase,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTurnRenderUnitCache } from "./conversationTurnRenderUnitCache.js";
import {
  buildConversationTurnRenderUnits,
  type BuildConversationTurnRenderUnitsOptions,
} from "./conversationTurnRenderUnits.js";

function turn(id: number, running = false): ConversationRow[] {
  const base = { turnId: `turn-${id}`, createdAt: id * 1000, createdAtSeq: id * 3 };
  const header: TurnHeaderRow = {
    ...base,
    kind: "turnHeader",
    rowId: id * 3,
    origin: "userInput",
    state: running ? "running" : "completedSuccess",
    startedAt: id * 1000,
    ...(running ? {} : { endedAt: id * 1000 + 500 }),
  };
  const user: UserInputRow = {
    ...base,
    kind: "userInput",
    rowId: id * 3 + 1,
    origin: "realUser",
    text: `question ${id}`,
  };
  const assistant: AssistantTextRow = {
    ...base,
    kind: "assistantText",
    rowId: id * 3 + 2,
    state: running ? "streaming" : "complete",
    text: `answer ${id}`,
  };
  return [header, user, assistant];
}

function toolRow(id: number, turnId: string): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: id,
    turnId,
    createdAt: id,
    createdAtSeq: id,
    toolCallId: `call-${id}`,
    toolName: "mcp__fixture__edit",
    status: "success",
    inputText: "{}",
    display: { kind: "mcp_tool", serverName: "fixture", toolName: "edit" },
  };
}

function fixture() {
  const cache = new ConversationTurnRenderUnitCache();
  return (
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions = {},
  ) => {
    const result = buildConversationTurnRenderUnits(rows, options, cache);
    expect(result).toEqual(buildConversationTurnRenderUnits(rows, options));
    return result;
  };
}

/** provider 在 tool call 前后下发的空白正文占位：可见性为零，但不是分组边界。 */
function blankText(
  rowId: number,
  turnId: string,
  text: string,
  state: AssistantTextRow["state"],
): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    text,
    state,
  };
}

/** reasoning_start/reasoning_end 可能留下空的终态 thinking 块，同样不可见。 */
function blankReasoning(rowId: number, turnId: string): ReasoningRow {
  return {
    kind: "reasoning",
    rowId,
    turnId,
    createdAt: rowId,
    createdAtSeq: rowId,
    text: "  ",
    state: "complete",
  };
}

/** 保留 turn(id) 的权威 header/user，替换掉它自带的最终正文。 */
function withoutAssistantText(rows: readonly ConversationRow[]): ConversationRow[] {
  return rows.filter((row) => row.kind !== "assistantText");
}

describe("conversation turn render cache", () => {
  it("reuses unchanged historical units across immutable tail deltas", () => {
    const build = fixture();
    const rows = [...turn(0), ...turn(1), ...turn(2, true)];
    const before = build(rows, { nowMs: 3000 });
    const after = build(
      rows.map((row) =>
        row.rowId === 8 && row.kind === "assistantText"
          ? { ...row, text: row.text + " delta" }
          : row,
      ),
      { nowMs: 3000 },
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(build([...rows], { nowMs: 3000 })[0]).toBe(before[0]);
  });

  it("updates running durations without invalidating completed turns", () => {
    const build = fixture();
    const rows = [...turn(0), ...turn(1, true)];
    const before = build(rows, { nowMs: 2000 });
    const after = build(rows, { nowMs: 3000 });
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.workStatus?.durationMs).toBe(2000);
    expect(after[1]?.workSegments?.[0]?.workStatus?.durationMs).toBe(2000);
  });

  it("normalizes position after append, prepend, removal and filtering", () => {
    const build = fixture();
    const first = turn(1);
    const second = turn(2, true);
    const emptyHeader = turn(3)[0]!;
    const original = build(first);
    const appended = build([...first, ...second]);
    expect(appended[0]?.isLastTurn).toBe(false);
    expect(appended[1]?.isLastTurn).toBe(true);
    expect(build([...turn(0), ...first, ...second])[1]).toBe(appended[0]);
    const filtered = build([...first, emptyHeader]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.isLastTurn).toBe(true);
    expect(build([...first, emptyHeader])[0]).toBe(filtered[0]);
    expect(build(first)).toEqual(original);
    build([]);
    expect(build(first)[0]).not.toBe(filtered[0]);
  });

  it("preserves screenshot-only segment folding when the last turn changes", () => {
    const build = fixture();
    const rows = turn(0);
    const screenshot: ToolCallRow = {
      ...toolRow(20, "turn-0"),
      display: { kind: "node_repl_images", source: "browser_turn_end" },
    };
    const screenshotRows = [rows[0]!, rows[1]!, screenshot];
    const before = build(screenshotRows);
    expect(before[0]?.browserTurnEndRows).toEqual([screenshot]);
    expect(before[0]?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(false);
    const after = build([...screenshotRows, ...turn(1)]);
    expect(after[0]?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(false);
    build(screenshotRows);
  });

  it("does not mutate previously published rows or units during position changes", () => {
    const build = fixture();
    const rows = turn(0);
    rows.forEach(Object.freeze);
    Object.freeze(rows);
    const before = build(rows);
    before.forEach((unit) => {
      unit.workSegments?.forEach(Object.freeze);
      Object.freeze(unit.workSegments);
      Object.freeze(unit);
    });
    const after = build([...rows, ...turn(1, true)], { nowMs: 2000 });
    expect(before[0]?.isLastTurn).toBe(true);
    expect(after[0]?.isLastTurn).toBe(false);
  });

  it("invalidates replaced, removed, reordered and non-contiguous rows", () => {
    const build = fixture();
    const first = turn(0);
    const second = turn(1);
    build([...first, ...second]);
    build([first[0]!, second[0]!, first[1]!, second[1]!, first[2]!, second[2]!]);
    build([first[0]!, first[2]!, first[1]!, ...second]);
    build([first[1]!, first[2]!, ...second]);
    build([...first.map((row) => ({ ...row })), ...second]);
    build([first[0]!, first[1]!, ...second]);
  });

  it.each<SessionPhase>(["completedSuccess", "completedInterrupted", "error"])(
    "respects headerless phase changes to %s and restored authoritative headers",
    (sessionPhase) => {
      const build = fixture();
      const rows = turn(0, true);
      build(rows.slice(1), { nowMs: 1000 });
      build(rows.slice(1), { sessionPhase, nowMs: 2000 });
      build(rows, { sessionPhase, nowMs: 2000 });
      const header = rows[0] as TurnHeaderRow;
      build([{ ...header, state: "completedInterrupted" }, ...rows.slice(1)], { nowMs: 3000 });
      build([{ ...header, state: "failed" }, ...rows.slice(1)], { nowMs: 4000 });
    },
  );

  it("preserves guide segments, durations and action anchors", () => {
    const build = fixture();
    const rows = turn(0, true);
    const header = rows[0] as TurnHeaderRow;
    const assistant = rows[2] as AssistantTextRow;
    const guided: UserInputRow = {
      ...(rows[1] as UserInputRow),
      rowId: 4,
      entityId: "guide",
      guided: true,
      createdAt: 500,
      text: "steer",
    };
    const fixtureRows: ConversationRow[] = [
      {
        ...header,
        workSegments: [
          { segmentId: "a", startedAt: 0, activeMs: 500 },
          { segmentId: "b", triggerEntityId: "guide", startedAt: 500 },
        ],
      },
      rows[1]!,
      { ...assistant, state: "complete" },
      guided,
      { ...assistant, rowId: 5, actions: { canFork: true } },
    ];
    const before = build(fixtureRows, { nowMs: 1000 });
    const after = build(fixtureRows, { nowMs: 2000 });
    expect(after[0]?.workSegments).toHaveLength(2);
    expect(after[0]?.workSegments?.[0]?.workStatus?.durationMs).toBe(500);
    expect(after[0]?.workSegments?.[1]?.workStatus?.durationMs).toBe(1500);
    expect(after[0]).not.toBe(before[0]);
  });

  it("does not share units across cache instances", () => {
    const rows = turn(0);
    expect(fixture()(rows)[0]).not.toBe(fixture()(rows)[0]);
  });

  it("matches the oracle across seeded delta/replay/clock/history sequences", () => {
    const build = fixture();
    let seed = 42;
    let nextTurn = 4;
    let rows = [0, 1, 2, 3].flatMap((id) => turn(id, id === 3));
    for (let step = 0; step < 160; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      switch (seed % 6) {
        case 0:
          rows = [...rows, ...turn(nextTurn++, true)];
          break;
        case 1:
          rows = rows.map((row) =>
            row.kind === "assistantText" && row.turnId === rows.at(-1)?.turnId
              ? { ...row, text: row.text + " delta" }
              : row,
          );
          break;
        case 2:
          rows = rows.map((row) => ({ ...row }));
          break;
        case 3:
          rows = rows.slice(3);
          break;
        case 4:
          rows = [...turn(-step - 1), ...rows];
          break;
      }
      build(rows, { nowMs: 100000 + step * 1000 });
    }
  });
});

describe("blank provider placeholders", () => {
  it("drops empty streamed text/thinking from work rows without dropping the turn", () => {
    const build = fixture();
    const rows = [
      ...withoutAssistantText(turn(0, true)),
      toolRow(10, "turn-0"),
      blankText(11, "turn-0", "", "streaming"),
      blankReasoning(12, "turn-0"),
    ];
    const units = build(rows, { nowMs: 5000 });
    expect(units).toHaveLength(1);
    const unit = units[0]!;
    expect(unit.isRunning).toBe(true);
    expect(unit.assistantWorkRows.map((row) => row.rowId)).toEqual([10]);
    expect(unit.renderRows.some((row) => row.rowId === 11)).toBe(false);
    expect(unit.renderRows.some((row) => row.rowId === 12)).toBe(false);
    expect(unit.assistantTextRows).toEqual([]);
    expect(unit.latestAssistantTextRow).toBeUndefined();
    expect(unit.flowItems.map((item) => item.kind)).toEqual(["userInput", "assistantHistory"]);
  });

  it("never treats a blank block as the completed reply of a historical turn", () => {
    const build = fixture();
    const rows = [
      ...withoutAssistantText(turn(0)),
      toolRow(10, "turn-0"),
      blankText(11, "turn-0", "  \n", "complete"),
    ];
    const unit = build(rows)[0]!;
    expect(unit.isRunning).toBe(false);
    expect(unit.latestAssistantTextRow).toBeUndefined();
    expect(unit.assistantTextRows).toEqual([]);
    expect(unit.assistantWorkRows.map((row) => row.rowId)).toEqual([10]);
    expect(unit.workStatus?.state).toBe("completed");
    // 没有最终正文的历史轮仍默认展开「已工作」，空占位不能把它折叠掉。
    expect(unit.assistantHistoryDefaultOpen).toBe(true);
  });

  it("re-splits adjacency and invalidates the cache once the placeholder gains a body", () => {
    const build = fixture();
    const host = withoutAssistantText(turn(0, true));
    const first = build(
      [
        ...host,
        toolRow(10, "turn-0"),
        blankText(11, "turn-0", "", "streaming"),
        toolRow(12, "turn-0"),
      ],
      { nowMs: 5000 },
    );
    expect(first[0]!.assistantWorkRows.map((row) => row.rowId)).toEqual([10, 12]);
    expect(first[0]!.assistantHistoryRows.map((row) => row.rowId)).toEqual([10, 12]);

    const second = build(
      [
        ...host,
        toolRow(10, "turn-0"),
        blankText(11, "turn-0", "note", "complete"),
        toolRow(12, "turn-0"),
      ],
      { nowMs: 5000 },
    );
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.assistantWorkRows.map((row) => row.rowId)).toEqual([10, 11, 12]);
    expect(second[0]!.assistantHistoryRows.map((row) => row.rowId)).toEqual([10, 11, 12]);
  });

  it("keeps a real reply as the visible boundary after blank placeholders", () => {
    const build = fixture();
    const rows = [
      ...withoutAssistantText(turn(0)),
      toolRow(10, "turn-0"),
      blankText(11, "turn-0", "", "complete"),
      toolRow(12, "turn-0"),
      blankText(13, "turn-0", "answer", "complete"),
    ];
    const unit = build(rows)[0]!;
    expect(unit.assistantWorkRows.map((row) => row.rowId)).toEqual([10, 12, 13]);
    expect(unit.latestAssistantTextRow?.rowId).toBe(13);
    expect(unit.flowItems.map((item) => item.kind)).toEqual([
      "userInput",
      "assistantHistory",
      "assistantText",
    ]);
    expect(unit.assistantHistoryRows.map((row) => row.rowId)).toEqual([10, 12]);
    expect(unit.renderRows.some((row) => row.rowId === 11)).toBe(false);
  });
});
