import type { ReasoningRow, SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isExecuteToolCall,
  isExploreToolCall,
  isShellToolCallAwaitingCommand,
} from "@/lib/exploreToolCall.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { joinFilePath } from "@/lib/path.js";
import {
  isConversationReasoningRowVisible,
  isEmptyConversationTextRow,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { buildReasoningGroup } from "@/v4/conversationReasoningGroup.js";

/** Explore/Execute/Changes/Reads 共享的阶段容器形状（kind 由各成员收窄）。 */
interface ToolGroupRenderItem {
  key: string;
  rowId: number;
  rows: ToolCallRow[];
  node: TaskChatToolCallTreeNode;
}

export type ConversationAssistantWorkRenderItem =
  | ReturnType<typeof buildReasoningGroup>
  | { kind: "row"; key: string; row: AssistantWorkRow }
  | { kind: "agentToolCall"; key: string; row: ToolCallRow; subagentRow: SubagentRow }
  | (ToolGroupRenderItem & { kind: "exploreGroup" })
  | (ToolGroupRenderItem & { kind: "executeGroup" })
  | (ToolGroupRenderItem & { kind: "changesGroup" })
  | (ToolGroupRenderItem & { kind: "readGroup" });

export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export const ENABLE_TERMINAL_TOOL_CALL_GROUPING = true;
export const ENABLE_CHANGES_TOOL_CALL_GROUPING = true;

interface ConversationAssistantWorkRenderOptions {
  workspacePath?: string;
  stageTailIsRunning?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

// ConversationRowView 对这两类 marker 直接渲染 null；留在行序里只会在 flex gap-4 中
// 撑出一个空位，并让相邻工作段被误判成已经结束。
const NON_RENDERING_TIMELINE_MARKER_TYPES = new Set(["retryNotice", "checkpointRestored"]);

const TOOL_PATH_INPUT_FIELDS = ["file_path", "path", "filePath"] as const;

const isToolCallRow = (row: AssistantWorkRow): row is ToolCallRow => row.kind === "toolCall";

const isAgentToolCallRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) && SUBAGENT_TOOL_NAMES.has(row.toolName);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rowItem = (row: AssistantWorkRow): ConversationAssistantWorkRenderItem => ({
  kind: "row",
  key: `row:${row.rowId}`,
  row,
});

function isExploreToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExecuteToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isChangesToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) return false;
  // Plan commands publish their own plan card; the legacy create_* heuristic is not a file edit.
  if (row.toolName === "create_plan" || row.toolName === "update_plan") return false;
  return (
    resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "file-write"
  );
}

/** 文件读取行：read 既是只读探查，也是「读取」聚合的输入。 */
const isFileReadRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isToolCallRow(row) &&
  resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "file-read";

/** 非读取的只读探查（搜索/列目录等）：读取有独立聚合，不能把贴在一起的同文件读取吞进 Explore。 */
const isPlainExploreRow = (row: AssistantWorkRow): row is ToolCallRow =>
  isExploreToolCallRow(row) && !isFileReadRow(row);

/** 工具行作用的文件路径：终态 display 是权威事实，流式早期只有工具入参。 */
function readToolPath(row: ToolCallRow): string | undefined {
  const display = row.output?.display;
  if (display?.kind === "file_diff") return display.filePath;
  const input = row.input ?? toolCallRowToLegacyNode(row).toolCall.input;
  if (!isRecord(input)) return undefined;
  return TOOL_PATH_INPUT_FIELDS.map((field) => input[field]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

/** 同一文件的相对/绝对路径写法必须收敛到可比较形态。 */
const normalizeComparePath = (path: string): string =>
  path.trim().replaceAll("\\", "/").replace(/^\.\//, "");

/** 写入按工作区完整路径比较，不能把不同目录里同名文件或相同后缀当作同一文件。 */
function writePathKey(row: ToolCallRow, workspacePath: string | undefined): string | undefined {
  const path = readToolPath(row);
  if (!path) return undefined;
  const key = normalizeComparePath(
    workspacePath ? joinFilePath(workspacePath, path) : path,
  ).replaceAll("/./", "/");
  return /^[a-z]:\//i.test(key) ? key.toLowerCase() : key;
}

/** 绝对路径 `G:/repo/src/foo.ts` 与相对路径 `src/foo.ts` 指向同一个文件。 */
const isSameReadFile = (left: string, right: string) =>
  left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);

function shouldDeferUnclassifiedShellToolCall(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row) || (row.status !== "inputStreaming" && row.status !== "running")) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isShellToolCallAwaitingCommand({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function resolveGroupStageStatus(
  rows: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
): string {
  // Explore/Execute/Reads 父节点表达的是当前工作阶段，不是子工具执行状态的汇总。
  // 子工具可能已经全部完成，但只要当前运行工作段尚未出现下一条可见边界，父阶段仍在继续；
  // 反之，后续非当前分组内容已经出现时，即使迟到的子状态仍是 running，父阶段也必须结束。
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

type ToolGroupKind = "exploreGroup" | "executeGroup" | "readGroup";

interface ToolGroupSpec<K extends ToolGroupKind> {
  kind: K;
  prefix: string;
  toolName: string;
  title: string;
}

const EXPLORE_GROUP: ToolGroupSpec<"exploreGroup"> = {
  kind: "exploreGroup",
  prefix: "explore",
  toolName: "Explore",
  title: "Explore",
};

const EXECUTE_GROUP: ToolGroupSpec<"executeGroup"> = {
  kind: "executeGroup",
  prefix: "execute",
  toolName: "ExecuteGroup",
  title: "Execute",
};

const READ_GROUP: ToolGroupSpec<"readGroup"> = {
  kind: "readGroup",
  prefix: "reads",
  toolName: "ReadGroup",
  title: "Reads",
};

/** 分组 builder 只会在相邻同类工具聚合后调用；空数组不是合法状态。 */
function buildToolGroup<K extends ToolGroupKind>(
  rows: ToolCallRow[],
  stageTailIsRunning: boolean,
  group: ToolGroupSpec<K>,
  input: Record<string, unknown> = {},
): ToolGroupRenderItem & { kind: K } {
  const firstRow = rows[0]!;
  return {
    kind: group.kind,
    // 旧 key/toolId 包含末尾 row 和数量，每新增一个子工具都会重建组件，
    // 并让 ToolLayout 用新的 toolId 读取不到用户刚保存的展开状态。聚合身份锚定首个子工具，
    // 后续只更新 children，保证流式增长期间 React identity 和展开状态 identity 都稳定。
    key: `${group.prefix}:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `${group.prefix}:${firstRow.toolCallId}`,
        toolName: group.toolName,
        kind: group.kind,
        title: group.title,
        input,
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function buildChangesGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  const firstRow = rows[0]!;
  return {
    kind: "changesGroup" as const,
    key: `changes:${firstRow.rowId}`,
    rowId: firstRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `changes:${firstRow.toolCallId}`,
        toolName: "ChangesGroup",
        kind: "changesGroup",
        title: "Changes",
        input: {},
        // Changes 是 UI 阶段容器，不是真实工具；子项失败/取消只留在各自明细，
        // 父级仅表达当前阶段是否仍位于可见运行段尾部。
        status: stageTailIsRunning ? "in_progress" : "completed",
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function pushReasoningItem(items: ConversationAssistantWorkRenderItem[], rows: ReasoningRow[]) {
  if (rows.length === 1) items.push(rowItem(rows[0]!));
  else if (rows.length > 1) items.push(buildReasoningGroup(rows));
}

/** 从 index 起收集连续满足 match 的可见工具行；非匹配行（含思考、正文）与换 turn 都中断聚合。 */
function takeToolRun(
  rows: readonly AssistantWorkRow[],
  index: number,
  match: (row: AssistantWorkRow) => row is ToolCallRow,
): ToolCallRow[] {
  const run: ToolCallRow[] = [];
  const turnId = rows[index]!.turnId;
  while (index + run.length < rows.length) {
    const row = rows[index + run.length]!;
    if (row.turnId !== turnId || !match(row)) break;
    run.push(row);
  }
  return run;
}

/**
 * 紧贴同一文件的多次读取收成一个「读取」项；单次读取与不同文件的读取各自成行。
 *
 * 读取不是写操作：它绝不进入「更改」组，也不参与任何写次数与增删统计，
 * 所以同一文件“先读后改”会同时出现一个读取项和一个更改项。
 */
function pushReadRunItems(
  items: ConversationAssistantWorkRenderItem[],
  run: readonly ToolCallRow[],
  stageTailIsRunning: boolean,
) {
  let index = 0;
  while (index < run.length) {
    const first = run[index]!;
    const path = readToolPath(first);
    const key = path ? normalizeComparePath(path) : undefined;
    const sameFile: ToolCallRow[] = [first];
    index += 1;
    while (key && index < run.length) {
      const nextPath = readToolPath(run[index]!);
      if (!nextPath || !isSameReadFile(key, normalizeComparePath(nextPath))) break;
      sameFile.push(run[index]!);
      index += 1;
    }
    if (path && sameFile.length > 1) {
      const atTail = stageTailIsRunning && index === run.length;
      items.push(buildToolGroup(sameFile, atTail, READ_GROUP, { path }));
    } else for (const row of sameFile) items.push(rowItem(row));
  }
}

/**
 * Agent 工具行 ↔ subagent 行必须按 parentToolCallId 精确配对。
 *
 * 同一轮并发 Agent 工具的 tool call 行按模型输出顺序出现，但 SubagentSpawned
 * 事件按异步调度顺序到达；旧 FIFO 会把一个 Agent 的标题与另一个 childSessionId 拼在一起。
 * 仅对缺少新字段的历史数据保留“同 turn 唯一剩余一对”的无歧义兼容。
 */
function pairSubagentRows(rows: readonly AssistantWorkRow[]): {
  subagentByAgentToolRowId: Map<number, SubagentRow>;
  claimedSubagentRowIds: Set<number>;
} {
  const subagentByAgentToolRowId = new Map<number, SubagentRow>();
  const claimedSubagentRowIds = new Set<number>();
  const agentToolByTurnAndCallId = new Map<string, ToolCallRow>();
  const agentToolRows: ToolCallRow[] = [];
  const subagentRows: SubagentRow[] = [];
  const legacySubagentRows: SubagentRow[] = [];

  for (const row of rows) {
    if (isAgentToolCallRow(row)) {
      agentToolRows.push(row);
      agentToolByTurnAndCallId.set(`${row.turnId}\0${row.toolCallId}`, row);
    } else if (row.kind === "subagent") {
      subagentRows.push(row);
    }
  }
  for (const row of subagentRows) {
    if (!row.parentToolCallId) {
      legacySubagentRows.push(row);
      continue;
    }
    const host = agentToolByTurnAndCallId.get(`${row.turnId}\0${row.parentToolCallId}`);
    if (host && host.turnId === row.turnId && !subagentByAgentToolRowId.has(host.rowId)) {
      subagentByAgentToolRowId.set(host.rowId, row);
      claimedSubagentRowIds.add(row.rowId);
    }
  }

  const remainingAgentToolsByTurn = new Map<string, ToolCallRow[]>();
  for (const row of agentToolRows) {
    if (subagentByAgentToolRowId.has(row.rowId)) continue;
    const turnRows = remainingAgentToolsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      remainingAgentToolsByTurn.set(row.turnId, [row]);
    }
  }
  const legacySubagentsByTurn = new Map<string, SubagentRow[]>();
  for (const row of legacySubagentRows) {
    const turnRows = legacySubagentsByTurn.get(row.turnId);
    if (turnRows) {
      turnRows.push(row);
    } else {
      legacySubagentsByTurn.set(row.turnId, [row]);
    }
  }
  for (const [turnId, subagentRows] of legacySubagentsByTurn) {
    const toolRows = remainingAgentToolsByTurn.get(turnId);
    if (toolRows?.length !== 1 || subagentRows.length !== 1) continue;
    const host = toolRows[0];
    const subagent = subagentRows[0];
    if (!host || !subagent) continue;
    subagentByAgentToolRowId.set(host.rowId, subagent);
    claimedSubagentRowIds.add(subagent.rowId);
  }

  return { subagentByAgentToolRowId, claimedSubagentRowIds };
}

export function buildAssistantWorkRenderItems(
  rows: readonly AssistantWorkRow[],
  reasoningVisibility: ConversationReasoningVisibility,
  options?: ConversationAssistantWorkRenderOptions,
): ConversationAssistantWorkRenderItem[] {
  const items: ConversationAssistantWorkRenderItem[] = [];
  const enableExploreGrouping = options?.enableExploreGrouping ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING;
  const enableTerminalGrouping =
    options?.enableTerminalGrouping ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING;
  const enableChangesGrouping = options?.enableChangesGrouping ?? ENABLE_CHANGES_TOOL_CALL_GROUPING;
  // 聚合的“相邻”必须按用户实际可见的行序判断。等待 command 的 Shell 若只在循环中跳过，
  // 仍会占据数组位置，把紧贴的两条同类工具误判成被隔开；隐藏 reasoning 与无 UI 的 marker
  // 同理。先统一剔除暂不可见行，再做配对、聚合和尾部判断。
  const preparedRows = rows.filter((row) => {
    if (isEmptyConversationTextRow(row)) return false;
    if (
      row.kind === "reasoning" &&
      !isConversationReasoningRowVisible(row.rowId, reasoningVisibility)
    ) {
      return false;
    }
    if (row.kind === "timelineMarker" && NON_RENDERING_TIMELINE_MARKER_TYPES.has(row.marker.type))
      return false;
    return !shouldDeferUnclassifiedShellToolCall(row);
  });
  const { subagentByAgentToolRowId, claimedSubagentRowIds } = pairSubagentRows(preparedRows);
  const atStageTail = (cursor: number) =>
    options?.stageTailIsRunning === true && cursor === preparedRows.length;
  let index = 0;

  while (index < preparedRows.length) {
    const row = preparedRows[index]!;

    if (isToolCallRow(row)) {
      const pairedSubagent = subagentByAgentToolRowId.get(row.rowId);
      if (pairedSubagent) {
        items.push({
          kind: "agentToolCall",
          key: `agent:${row.rowId}`,
          row,
          subagentRow: pairedSubagent,
        });
        index += 1;
        continue;
      }
    }

    // 已配对进 Agent 块的 subagent 行：不再单独渲染。
    if (row.kind === "subagent" && claimedSubagentRowIds.has(row.rowId)) {
      index += 1;
      continue;
    }

    // 思考只与紧邻的思考合并，并且是工具聚合的硬边界：跨 thinking 的操作绝不合并。
    if (row.kind === "reasoning" && row.state !== "interrupted") {
      const run: ReasoningRow[] = [row];
      index += 1;
      while (index < preparedRows.length) {
        const next = preparedRows[index]!;
        if (next.turnId !== row.turnId) break;
        if (next.kind !== "reasoning" || next.state === "interrupted") break;
        run.push(next);
        index += 1;
      }
      pushReasoningItem(items, run);
      continue;
    }

    if (isFileReadRow(row)) {
      const run = takeToolRun(preparedRows, index, isFileReadRow);
      index += run.length;
      pushReadRunItems(items, run, atStageTail(index));
      continue;
    }

    if (isChangesToolCallRow(row)) {
      const path = writePathKey(row, options?.workspacePath);
      const run = takeToolRun(
        preparedRows,
        index,
        (candidate): candidate is ToolCallRow =>
          isChangesToolCallRow(candidate) &&
          (candidate === row ||
            enableChangesGrouping ||
            (path !== undefined && writePathKey(candidate, options?.workspacePath) === path)),
      );
      index += run.length;
      /** 旧的跨文件分组开关可能为 false；同文件紧邻编辑仍合并，不能被它整段短路。 */
      if (run.length > 1) items.push(buildChangesGroup(run, atStageTail(index)));
      else items.push(...run.map(rowItem));
      continue;
    }

    if (isPlainExploreRow(row)) {
      const run = takeToolRun(preparedRows, index, isPlainExploreRow);
      index += run.length;
      // Explore 只有在出现第二个相邻只读工具后才成立；首项必须立即按原工具展示。
      if (enableExploreGrouping && run.length > 1) {
        items.push(buildToolGroup(run, atStageTail(index), EXPLORE_GROUP));
      } else items.push(...run.map(rowItem));
      continue;
    }

    if (enableTerminalGrouping && isExecuteToolCallRow(row)) {
      const run = takeToolRun(preparedRows, index, isExecuteToolCallRow);
      index += run.length;
      // 单个工具保留自身语义和渲染，避免只包含一个子项的 Terminal 容器。
      if (run.length > 1) items.push(buildToolGroup(run, atStageTail(index), EXECUTE_GROUP));
      else items.push(...run.map(rowItem));
      continue;
    }

    items.push(rowItem(row));
    index += 1;
  }

  return items;
}
