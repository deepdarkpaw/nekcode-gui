import { createHash } from "node:crypto";
import type {
  ArtifactRow,
  AssistantTextRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerLane,
  TimelineMarkerPayload,
  TimelineMarkerRow,
  ToolCallRow,
  ToolOutput,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  NekAgentMessage,
  NekAssistantMessage,
  NekTextContent,
  NekThinkingContent,
  NekToolCall,
} from "@zcode/shared/nek-protocol";

/**
 * nek 数据 → v4 行的纯构造函数。
 *
 * 约定：本文件只做"形状转换"，不维护状态机（状态迁移在 `nekConversationProjector.ts`）。
 * 每个构造函数都要求调用方给出 `rowId` / `turnId` / `entityId`，因为行身份由投影器独占分配。
 */

export interface NekRowIdentity {
  rowId: number;
  turnId: string;
  /** 稳定身份：entries 路径用 `<entryId>#<内容块序号>`，工具行用 `tool:<toolCallId>`。 */
  entityId: string;
  createdAt: number;
}

/** ISO 8601 或 Unix 毫秒 → 毫秒。 */
export function toEpochMs(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** 文本内容块或字符串 → 纯文本。 */
export function contentText(
  content: string | Array<NekTextContent | { type: string }> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is NekTextContent =>
        block.type === "text" && typeof (block as NekTextContent).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** assistant 消息里的文本块。 */
export function assistantTextBlocks(
  message: NekAssistantMessage,
): Array<{ index: number; text: string }> {
  const blocks: Array<{ index: number; text: string }> = [];
  message.content.forEach((block, index) => {
    if (block.type === "text") blocks.push({ index, text: block.text });
  });
  return blocks;
}

/** assistant 消息里的思考块。 */
export function assistantThinkingBlocks(
  message: NekAssistantMessage,
): Array<{ index: number; text: string; redacted: boolean }> {
  const blocks: Array<{ index: number; text: string; redacted: boolean }> = [];
  message.content.forEach((block, index) => {
    if (block.type === "thinking") {
      blocks.push({ index, text: block.thinking, redacted: block.redacted === true });
    }
  });
  return blocks;
}

/** assistant 消息里的工具调用块。 */
export function assistantToolCalls(
  message: NekAssistantMessage,
): Array<{ index: number; toolCall: NekToolCall }> {
  const calls: Array<{ index: number; toolCall: NekToolCall }> = [];
  message.content.forEach((block, index) => {
    if (block.type === "toolCall") calls.push({ index, toolCall: block });
  });
  return calls;
}

/** 工具结果 / 部分结果 → 纯文本（`{ content: [...] }` 形状，或直接是字符串）。 */
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null)
    return result === undefined ? "" : safeJson(result);
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return contentText(content as Array<{ type: string }>);
  return safeJson(result);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 工具结果的展示载荷。只映射 v4 已有 display 的类别：
 * bash 输出 → `bash_output`；其余保持纯文本（`details` 原样进 `input`/`error`，不进 display）。
 */
export function toolResultDisplay(
  toolName: string,
  result: unknown,
  outputText: string,
): ToolOutput["display"] | undefined {
  if (result === undefined) return undefined;
  const details = (result as { details?: unknown }).details;
  if (toolName === "bash" || toolName === "bash_output") {
    const truncated = (details as { truncated?: unknown } | undefined)?.truncated === true;
    const outputPath = (details as { fullOutputPath?: unknown } | undefined)?.fullOutputPath;
    return {
      kind: "bash_output",
      output: outputText.slice(0, 150_000),
      truncated,
      ...(typeof outputPath === "string" && outputPath !== "" ? { outputPath } : {}),
    };
  }
  return undefined;
}

/** 计划预览（`nek.plan_preview` custom message）→ artifact 行：产出的 Markdown 文档。 */
export interface NekPlanPreviewDetails {
  plan: {
    name: string;
    path: string;
    revision: number;
    overview: string;
    todos?: Array<{ id: string; content: string }>;
  };
  markdown: string;
}

export function isPlanPreviewDetails(value: unknown): value is NekPlanPreviewDetails {
  if (typeof value !== "object" || value === null) return false;
  const plan = (value as { plan?: unknown }).plan;
  if (typeof plan !== "object" || plan === null) return false;
  const record = plan as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.path === "string" &&
    typeof record.revision === "number" &&
    typeof (value as { markdown?: unknown }).markdown === "string"
  );
}

/** 计划 Markdown → artifact 行（`artifactType: "md"`，sha256 由内容算出）。 */
export function buildPlanArtifactRow(
  identity: NekRowIdentity,
  details: NekPlanPreviewDetails,
): ArtifactRow {
  const markdown = details.markdown;
  const digest = createHash("sha256").update(markdown, "utf8").digest("hex");
  return {
    rowId: identity.rowId,
    turnId: identity.turnId,
    entityId: identity.entityId,
    createdAt: identity.createdAt,
    createdAtSeq: identity.rowId,
    kind: "artifact",
    artifactVersionId: `${details.plan.path}#r${details.plan.revision}`,
    logicalArtifactKey: details.plan.path,
    displayName: details.plan.name,
    artifactType: "md",
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(markdown, "utf8"),
    sha256: digest,
    ref: details.plan.path,
    state: "current",
  };
}

// ============================================================================
// 行构造
// ============================================================================

const rowBase = (identity: NekRowIdentity) => ({
  rowId: identity.rowId,
  turnId: identity.turnId,
  entityId: identity.entityId,
  createdAt: identity.createdAt,
  createdAtSeq: identity.rowId,
});

/** 轮头。nek 的一轮 = 一条用户输入 + 随后的 assistant/tool 活动，直到 `agent_settled`。 */
export function buildTurnHeaderRow(
  identity: NekRowIdentity,
  args: {
    origin?: TurnHeaderRow["origin"];
    state?: TurnHeaderRow["state"];
    executionKind?: "agent" | "controlOnly";
  },
): TurnHeaderRow {
  const origin = args.origin ?? "userInput";
  const state = args.state ?? "running";
  return {
    ...rowBase(identity),
    kind: "turnHeader",
    origin,
    executionKind: args.executionKind ?? "agent",
    state,
    startedAt: identity.createdAt,
    ...(state === "running" ? {} : { endedAt: identity.createdAt }),
  };
}

/** 用户输入。images 无法变成 v4 attachment ref，见报告里的已知缺口。 */
export function buildUserInputRow(
  identity: NekRowIdentity,
  args: { text: string; origin?: UserInputRow["origin"]; guided?: boolean },
): UserInputRow {
  return {
    ...rowBase(identity),
    kind: "userInput",
    text: args.text,
    origin: args.origin ?? "realUser",
    ...(identity.entityId.startsWith("entry:") ? { actions: { canFork: true as const } } : {}),
    ...(args.guided ? { guided: true as const } : {}),
  };
}

export function buildAssistantTextRow(
  identity: NekRowIdentity,
  args: {
    text: string;
    state: AssistantTextRow["state"];
    model?: string;
    assistantResponseId?: string;
  },
): AssistantTextRow {
  return {
    ...rowBase(identity),
    kind: "assistantText",
    text: args.text,
    state: args.state,
    ...(args.model ? { model: args.model } : {}),
    ...(args.assistantResponseId ? { assistantResponseId: args.assistantResponseId } : {}),
  };
}

export function buildReasoningRow(
  identity: NekRowIdentity,
  args: {
    text: string;
    state: ReasoningRow["state"];
    assistantResponseId?: string;
    durationMs?: number;
  },
): ReasoningRow {
  return {
    ...rowBase(identity),
    kind: "reasoning",
    text: args.text,
    state: args.state,
    ...(args.assistantResponseId ? { assistantResponseId: args.assistantResponseId } : {}),
    ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs }),
  };
}

export function buildToolCallRow(
  identity: NekRowIdentity,
  args: {
    toolCallId: string;
    toolName: string;
    status: ToolCallRow["status"];
    inputText?: string;
    input?: unknown;
    output?: ToolOutput;
    error?: { code: string; message: string };
    assistantResponseId?: string;
    startedAt?: number;
    endedAt?: number;
  },
): ToolCallRow {
  return {
    ...rowBase(identity),
    kind: "toolCall",
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    status: args.status,
    inputText: args.inputText ?? "",
    ...(args.input === undefined ? {} : { input: args.input }),
    ...(args.output === undefined ? {} : { output: args.output }),
    ...(args.error === undefined ? {} : { error: args.error }),
    ...(args.assistantResponseId ? { assistantResponseId: args.assistantResponseId } : {}),
    ...(args.startedAt === undefined ? {} : { startedAt: args.startedAt }),
    ...(args.endedAt === undefined ? {} : { endedAt: args.endedAt }),
  };
}

export function buildSubagentRow(
  identity: NekRowIdentity,
  args: {
    subagentType: string;
    status: SubagentRow["status"];
    summaryText: string;
    parentToolCallId?: string;
    childSessionId?: string;
    startedAt?: number;
    endedAt?: number;
  },
): SubagentRow {
  return {
    ...rowBase(identity),
    kind: "subagent",
    subagentType: args.subagentType,
    status: args.status,
    summaryText: args.summaryText,
    ...(args.parentToolCallId ? { parentToolCallId: args.parentToolCallId } : {}),
    ...(args.childSessionId ? { childSessionId: args.childSessionId } : {}),
    ...(args.startedAt === undefined ? {} : { startedAt: args.startedAt }),
    ...(args.endedAt === undefined ? {} : { endedAt: args.endedAt }),
  };
}

/**
 * 模型/思考等级切换的 marker。
 *
 * v4 的 `modelChange` 要求 `fromProvider`/`fromModel` 同时在场或同时缺席（`never` 保证），
 * 所以这里显式分支：没有来源时走"∅→X"那一支。
 */
export function buildModelChangeMarker(args: {
  from?: { provider: string; model: string };
  to: { provider: string; model: string };
  toThought: string;
}): TimelineMarkerPayload {
  if (args.from) {
    return {
      type: "modelChange",
      fromProvider: args.from.provider,
      fromModel: args.from.model,
      toProvider: args.to.provider,
      toModel: args.to.model,
      toThought: args.toThought,
    };
  }
  return {
    type: "modelChange",
    toProvider: args.to.provider,
    toModel: args.to.model,
    toThought: args.toThought,
  };
}

export function buildTimelineMarkerRow(
  identity: NekRowIdentity,
  marker: TimelineMarkerPayload,
  lane?: TimelineMarkerLane,
): TimelineMarkerRow {
  return {
    ...rowBase(identity),
    kind: "timelineMarker",
    marker,
    ...(lane ? { lane } : {}),
  };
}

/** 该 nek 消息是否值得投影成行（system 消息是 prompt 状态，不进对话）。 */
export function isConversationMessage(message: NekAgentMessage): boolean {
  return message.role !== "system";
}

/** 思考块是否只有加密载荷（此时没有可展示文本）。 */
export function isRedactedThinking(block: NekThinkingContent): boolean {
  return block.redacted === true && block.thinking.trim() === "";
}
