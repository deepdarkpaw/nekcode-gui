import type { ReasoningRow, SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isExecuteToolCall,
  isExploreToolCall,
  isShellToolCallAwaitingCommand,
} from "@/lib/exploreToolCall.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationReasoningVisibility,
} from "@/v4/conversationRowContext.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { buildReasoningGroup } from "@/v4/conversationReasoningGroup.js";

/** Explore/Execute/Changes 共享的阶段容器形状（kind 由各成员收窄）。 */
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
  | (ToolGroupRenderItem & { kind: "changesGroup" });

export const ENABLE_EXPLORE_TOOL_CALL_GROUPING = true;
export const ENABLE_TERMINAL_TOOL_CALL_GROUPING = true;
export const ENABLE_CHANGES_TOOL_CALL_GROUPING = true;

interface ConversationAssistantWorkRenderOptions {
  stageTailIsRunning?: boolean;
  enableExploreGrouping?: boolean;
  enableTerminalGrouping?: boolean;
  enableChangesGrouping?: boolean;
}

interface FileWorkStageOptions {
  tailIsRunning: boolean;
  enableExploreGrouping: boolean;
  enableChangesGrouping: boolean;
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

function isExploreToolCallRow(row: AssistantWorkRow): boolean {
  if (!isToolCallRow(row)) {
    return false;
  }
  const legacyNode = toolCallRowToLegacyNode(row);
  return isExploreToolCall({
    kind: legacyNode.toolCall.kind,
    input: legacyNode.toolCall.input,
  });
}

function isExecuteToolCallRow(row: AssistantWorkRow): row is ToolCallRow {
  if (!isToolCallRow(row)) {
    return false;
  }
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

/** 工具行作用的文件路径：终态 display 是权威事实，流式早期只有工具入参。 */
function readToolPath(row: ToolCallRow): string | undefined {
  const display = row.output?.display;
  if (display?.kind === "file_diff") return display.filePath;
  const input = row.input;
  if (!isRecord(input)) return undefined;
  return TOOL_PATH_INPUT_FIELDS.map((field) => input[field]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

/** 同一文件的相对/绝对路径写法必须收敛到可比较形态。 */
const normalizeComparePath = (path: string): string =>
  path.trim().replaceAll("\\", "/").replace(/^\.\//, "");

/**
 * 同一文件内被修改文件的只读读取：绝对路径 `G:/repo/src/foo.ts` 与相对路径
 * `src/foo.ts` 也要收敛到同一文件，否则读写在 Changes 里仍然裂成两条。
 */
function isSameFileReadRow(row: ToolCallRow, editedPaths: ReadonlySet<string>): boolean {
  if (
    resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family !== "file-read"
  )
    return false;
  const readPath = readToolPath(row);
  if (!readPath) return false;
  const normalized = normalizeComparePath(readPath);
  return [...editedPaths].some(
    (editedPath) =>
      normalized === editedPath ||
      editedPath.endsWith(`/${normalized}`) ||
      normalized.endsWith(`/${editedPath}`),
  );
}

function collectEditedPaths(toolRows: readonly ToolCallRow[]): Set<string> {
  const paths: string[] = [];
  for (const row of toolRows) {
    const filePath = isChangesToolCallRow(row) ? readToolPath(row) : undefined;
    if (filePath) paths.push(normalizeComparePath(filePath));
  }
  return new Set(paths);
}

/**
 * 静默文件工作段候选：同一 turn 内的思考、只读探索与文件写入。
 *
 * 真实推理模型每次工具调用前都先发一条 reasoning，所以“原始下标连续”不再是合并前提；
 * 真正需要切段的只有正文、可见 marker、子代理、终端命令与交互/控制工具，它们都不是
 * 候选，天然构成硬边界（改文件 → 跑测试 → 再改文件必须分成前后两段）。
 */
function isFileWorkStageCandidate(row: AssistantWorkRow): boolean {
  if (row.kind === "reasoning") return row.state !== "interrupted";
  if (!isToolCallRow(row)) return false;
  return isExploreToolCallRow(row) || isChangesToolCallRow(row);
}

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
  // Explore/Execute 父节点表达的是当前工作阶段，不是子工具执行状态的汇总。
  // 子工具可能已经全部完成，但只要当前运行工作段尚未出现下一条可见边界，父阶段仍在继续；
  // 反之，后续非当前分组内容已经出现时，即使迟到的子状态仍是 running，父阶段也必须结束。
  if (stageTailIsRunning) return "in_progress";
  return rows.some((row) => row.status === "cancelled") ? "stopped" : "completed";
}

type ToolGroupKind = "exploreGroup" | "executeGroup";

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

/** 分组 builder 只会在连续同类工具达到两项后调用；空数组不是合法状态。 */
function buildToolGroup<K extends ToolGroupKind>(
  rows: ToolCallRow[],
  stageTailIsRunning: boolean,
  group: ToolGroupSpec<K>,
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
        input: {},
        status: resolveGroupStageStatus(rows, stageTailIsRunning),
        startedAt: typeof firstRow.startedAt === "number" ? firstRow.startedAt : undefined,
      },
      childToolCalls: rows.map(toolCallRowToLegacyNode),
    },
  };
}

function buildChangesGroup(rows: ToolCallRow[], stageTailIsRunning: boolean) {
  // 组内可能先出现同文件的只读 read（读取 → 编辑 → 再读取）。identity 必须锚定第一条
  // 真实写操作：否则 read 流式进入/离开会换掉 owner，用户刚展开的“更改”会被重建。
  const firstWriteRow = rows.find(isChangesToolCallRow) ?? rows[0]!;
  return {
    kind: "changesGroup" as const,
    key: `changes:${firstWriteRow.rowId}`,
    rowId: firstWriteRow.rowId,
    rows,
    node: {
      toolCall: {
        toolId: `changes:${firstWriteRow.toolCallId}`,
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

/**
 * 静默文件工作段 → 展示项：思考 → 其它只读探索 → 文件修改。
 *
 * 文件修改项里并入读取了本段被修改文件的 read（保持原始先后），这样
 * `read → reasoning → edit → read → edit` 只剩一个 Changes，而不是一串碎片行；
 * 读取不是写操作，只进入文件明细，不参与任何写次数与增删统计。
 */
function buildFileWorkStageItems(
  stageRows: readonly AssistantWorkRow[],
  options: FileWorkStageOptions,
): ConversationAssistantWorkRenderItem[] {
  const items: ConversationAssistantWorkRenderItem[] = [];
  const reasoningRows: ReasoningRow[] = [];
  const toolRows: ToolCallRow[] = [];
  for (const row of stageRows) {
    if (row.kind === "reasoning") reasoningRows.push(row);
    else if (isToolCallRow(row)) toolRows.push(row);
  }

  if (reasoningRows.length === 1) items.push(rowItem(reasoningRows[0]!));
  else if (reasoningRows.length > 1) items.push(buildReasoningGroup(reasoningRows));

  const editedPaths = collectEditedPaths(toolRows);
  const changeRows: ToolCallRow[] = [];
  const exploreRows: ToolCallRow[] = [];
  for (const row of toolRows) {
    const target =
      isChangesToolCallRow(row) || isSameFileReadRow(row, editedPaths) ? changeRows : exploreRows;
    target.push(row);
  }

  // 单个只读工具保留自身语义与渲染，只有出现第二个同类调用才成立 Explore 容器。
  if (options.enableExploreGrouping && exploreRows.length > 1) {
    items.push(
      buildToolGroup(exploreRows, options.tailIsRunning && changeRows.length === 0, EXPLORE_GROUP),
    );
  } else {
    for (const row of exploreRows) items.push(rowItem(row));
  }

  if (options.enableChangesGrouping && changeRows.length > 0) {
    items.push(buildChangesGroup(changeRows, options.tailIsRunning));
  } else {
    for (const row of changeRows) items.push(rowItem(row));
  }
  return items;
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
  // 工作段的边界和尾部状态必须基于用户实际可见的行序。等待 command 的 Shell 若只在
  // 循环中跳过，仍会占据数组位置，导致前一个 Explore 被误判为已结束；隐藏 reasoning
  // 和无 UI 的 marker 也有相同问题。先统一剔除暂不可见行，再做配对、分组和尾部判断。
  const preparedRows = rows.filter((row) => {
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
  const stageTailIsRunning = (cursor: number) =>
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

    if (isFileWorkStageCandidate(row)) {
      const stageRows: AssistantWorkRow[] = [row];
      index += 1;
      while (index < preparedRows.length) {
        const nextRow = preparedRows[index]!;
        if (nextRow.turnId !== row.turnId || !isFileWorkStageCandidate(nextRow)) break;
        stageRows.push(nextRow);
        index += 1;
      }
      items.push(
        ...buildFileWorkStageItems(stageRows, {
          tailIsRunning: stageTailIsRunning(index),
          enableExploreGrouping,
          enableChangesGrouping,
        }),
      );
      continue;
    }

    if (enableTerminalGrouping && isExecuteToolCallRow(row)) {
      const groupRows: ToolCallRow[] = [row];
      index += 1;
      while (index < preparedRows.length) {
        const nextRow = preparedRows[index]!;
        if (!isExecuteToolCallRow(nextRow)) break;
        groupRows.push(nextRow);
        index += 1;
      }
      // 单个工具保留自身语义和渲染，避免只包含一个子项的 Terminal 容器。
      items.push(
        groupRows.length === 1
          ? rowItem(row)
          : buildToolGroup(groupRows, stageTailIsRunning(index), EXECUTE_GROUP),
      );
      continue;
    }

    items.push(rowItem(row));
    index += 1;
  }

  return items;
}
