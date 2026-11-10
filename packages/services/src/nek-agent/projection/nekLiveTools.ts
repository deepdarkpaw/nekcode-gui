import type { NekSubagentRecord } from "@zcode/shared/nek-protocol";
import type { ConversationRow, ToolCallRow, ToolOutput } from "@zcode/shared/zcode-protocol-v4";
import { buildToolCallRow, toolResultDisplay, toolResultText } from "./nekRows.js";
import { mergeToolResultRow } from "./nekToolResultRow.js";
import { currentTurnId, rowIdentity } from "./nekLiveTurn.js";
import type { NekLiveContext } from "./nekLiveTurn.js";
import { subagentRowFromRecord } from "./nekProjectionSnapshot.js";
import { extractSubagentsFromToolResult } from "./nekSubagentRecords.js";

/**
 * 工具执行与子代理行。
 *
 * 工具行身份统一用 `tool:<toolCallId>`：它同时出现在 `message_end` 的 toolCall 内容块、
 * `tool_execution_*` 事件与 `toolResult` 消息里，是唯一跨阶段稳定的键。
 */

function toolRowId(ctx: NekLiveContext, toolCallId: string): number {
  const known = ctx.toolRows.get(toolCallId);
  if (known !== undefined) return known;
  const rowId = ctx.store.allocate(`tool:${toolCallId}`);
  ctx.toolRows.set(toolCallId, rowId);
  return rowId;
}

function upsertToolRow(
  ctx: NekLiveContext,
  toolCallId: string,
  toolName: string,
  patch: (row: ToolCallRow) => ToolCallRow,
): void {
  const rowId = toolRowId(ctx, toolCallId);
  const existing = ctx.store.getRow<ToolCallRow>(rowId);
  if (!existing) {
    ctx.store.add(
      patch(
        buildToolCallRow(rowIdentity(`tool:${toolCallId}`, rowId, currentTurnId(ctx), ctx.now()), {
          toolCallId,
          toolName,
          status: "inputStreaming",
          inputText: "",
          startedAt: ctx.now(),
        }),
      ),
    );
    return;
  }
  ctx.store.update(rowId, (row) => (row.kind === "toolCall" ? patch({ ...row, toolName }) : row));
}

export function applyToolExecutionStart(
  ctx: NekLiveContext,
  toolCallId: string,
  toolName: string,
  args: unknown,
): void {
  const rowId = toolRowId(ctx, toolCallId);
  const startedAt = ctx.now();
  const existing = ctx.store.getRow<ToolCallRow>(rowId);
  if (!existing) {
    ctx.store.add(
      buildToolCallRow(rowIdentity(`tool:${toolCallId}`, rowId, currentTurnId(ctx), startedAt), {
        toolCallId,
        toolName,
        status: "running",
        inputText: args === undefined ? "" : JSON.stringify(args, null, 2),
        input: args,
        startedAt,
      }),
    );
    return;
  }
  ctx.store.update(rowId, (row) =>
    row.kind === "toolCall"
      ? {
          ...row,
          status: "running",
          input: args === undefined ? row.input : args,
          inputText: args === undefined ? row.inputText : JSON.stringify(args, null, 2),
          startedAt: row.startedAt ?? startedAt,
        }
      : row,
  );
}

export function applyToolExecutionUpdate(
  ctx: NekLiveContext,
  toolCallId: string,
  toolName: string,
  args: unknown,
  partialResult: unknown,
): void {
  const text = toolResultText(partialResult);
  const output: ToolOutput = {
    text,
    display: toolResultDisplay(toolName, partialResult, text, args),
  };
  upsertToolRow(ctx, toolCallId, toolName, (row) => ({
    ...row,
    status: "running",
    input: row.input === undefined ? args : row.input,
    inputText: row.inputText || (args === undefined ? "" : JSON.stringify(args, null, 2)),
    // partialResult 是"最新部分结果"，按替换处理（由工具的契约决定语义）。
    output,
  }));
}

export function applyToolExecutionEnd(
  ctx: NekLiveContext,
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const details = (result as { details?: unknown } | undefined)?.details;
  if (details !== undefined) ctx.toolDetails.set(toolCallId, details);
  const endedAt = ctx.now();
  const rowId = toolRowId(ctx, toolCallId);
  ctx.store.add(
    mergeToolResultRow(
      rowIdentity(`tool:${toolCallId}`, rowId, currentTurnId(ctx), endedAt),
      ctx.store.getRow(rowId),
      { toolCallId, toolName, result, isError, endedAt },
    ),
  );
  applySubagentDetails(ctx, toolName, toolCallId, details);
}

/** Live and replay share the typed subagent/await/stop_subagent result contract. */
export function applySubagentDetails(
  ctx: NekLiveContext,
  toolName: string,
  toolCallId: string,
  details: unknown,
): void {
  for (const { record, parentToolCallId } of extractSubagentsFromToolResult(
    toolName,
    toolCallId,
    details,
  )) {
    applySubagentRecord(ctx, record, parentToolCallId);
  }
}

/** `extension_event: nek.subagent` 与工具 details 共用的子代理行更新。 */
export function applySubagentRecord(
  ctx: NekLiveContext,
  record: NekSubagentRecord,
  parentToolCallId?: string,
): void {
  const entityId = `subagent:${record.id}`;
  const rowId = ctx.store.allocate(entityId);
  const existing = ctx.store.getRow(rowId);
  const createdAt = existing?.createdAt ?? record.startedAt;
  const subagent = existing?.kind === "subagent" ? existing : undefined;
  const parentId = subagent?.parentToolCallId ?? parentToolCallId;
  const parentRowId = parentId ? ctx.store.findRowId(`tool:${parentId}`) : undefined;
  const parent = parentRowId === undefined ? undefined : ctx.store.getRow(parentRowId);
  // Progress belongs to the spawn, not to whichever user turn happens to be active now.
  // A later tool result may fill the parent anchor missing from the first extension event.
  const turnId = parent?.turnId ?? subagent?.turnId ?? currentTurnId(ctx);
  const row = subagentRowFromRecord(entityId, rowId, turnId, record, parentId);
  ctx.store.add({ ...row, createdAt, createdAtSeq: rowId } as ConversationRow);
}
