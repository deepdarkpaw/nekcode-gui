import type { NekHistoryEntry } from "@zcode/shared/nek-protocol";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildToolCallRow,
  buildTimelineMarkerRow,
  buildModelErrorMarker,
  contentText,
  toEpochMs,
} from "./nekRows.js";
import { HISTORY_ROW_STRIDE, historyRowId } from "./nekHistoryIdentity.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function displayMessage(source: NekHistoryEntry): Record<string, unknown> | undefined {
  return record(source.entry) && record(source.entry.message) ? source.entry.message : undefined;
}
const refs = (source: NekHistoryEntry) =>
  source.omissions.map((omission) => ({ ...omission, entryId: source.id }));

/** Content omission is a display state, never evidence of interruption or model success. */
export function partialAssistantError(source: NekHistoryEntry): ConversationRow | undefined {
  if (!source.omissions.length) return;
  const message = displayMessage(source);
  if (message?.role !== "assistant" || message.stopReason !== "error") return;
  const marker = buildModelErrorMarker({
    stopReason: "error",
    provider: typeof message.provider === "string" ? message.provider : "",
    model: typeof message.model === "string" ? message.model : "",
    api: typeof message.api === "string" ? message.api : "",
    ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
  });
  return buildTimelineMarkerRow(
    {
      rowId: historyRowId(source.position, HISTORY_ROW_STRIDE - 3),
      entityId: `model-error:${source.id}`,
      turnId: source.turnId,
      createdAt: toEpochMs(source.timestamp),
    },
    marker!,
    "turnTailBoundary",
  );
}

/** Parse only surviving call identities. Partial display objects never become model/session entries. */
export function partialToolCalls(source: NekHistoryEntry): ToolCallRow[] {
  if (!source.omissions.length) return [];
  const message = displayMessage(source);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block: unknown, index: number): ToolCallRow[] => {
    if (
      !record(block) ||
      block.type !== "toolCall" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string"
    )
      return [];
    const slot = 18 + index * 4;
    if (slot >= HISTORY_ROW_STRIDE - 4)
      throw new Error("nek history content-block identity overflow");
    const row = buildToolCallRow(
      {
        entityId: `tool:${block.id}`,
        rowId: historyRowId(source.position, slot),
        turnId: source.turnId,
        createdAt: toEpochMs(source.timestamp),
      },
      {
        toolCallId: block.id,
        toolName: block.name,
        status: "inputStreaming",
        ...(record(block.arguments)
          ? { input: block.arguments, inputText: JSON.stringify(block.arguments) }
          : {}),
      },
    );
    return [{ ...row, historyContent: refs(source) }];
  });
}

/** Known result status is separate from omitted output bytes; no fabricated successful body. */
export function partialToolResult(
  source: NekHistoryEntry,
  anchors: readonly ConversationRow[],
): ToolCallRow | undefined {
  if (!source.omissions.length) return;
  const message = displayMessage(source);
  if (
    message?.role !== "toolResult" ||
    typeof message.toolCallId !== "string" ||
    typeof message.toolName !== "string" ||
    typeof message.isError !== "boolean"
  )
    return;
  const anchor =
    anchors.findLast((row) => row.kind === "toolCall" && row.toolCallId === message.toolCallId) ??
    (source.toolCallOrigin === null
      ? buildToolCallRow(
          {
            entityId: `tool:${message.toolCallId}`,
            rowId: historyRowId(source.position, 2),
            turnId: source.turnId,
            createdAt: toEpochMs(source.timestamp),
          },
          { toolCallId: message.toolCallId, toolName: message.toolName, status: "inputStreaming" },
        )
      : undefined);
  if (anchor?.kind !== "toolCall")
    throw new Error("nek HISTORY_ANCHOR_REQUIRED: deferred result has no original tool call seed");
  const text = Array.isArray(message.content)
    ? contentText(
        message.content.filter(
          (block: unknown): block is { type: "text"; text: string } =>
            record(block) && block.type === "text" && typeof block.text === "string",
        ),
      )
    : "";
  const historyContent = [
    ...new Map(
      [...(anchor.historyContent ?? []), ...refs(source)].map((ref) => [
        `${ref.entryId}:${ref.pointer}`,
        ref,
      ]),
    ).values(),
  ];
  return {
    ...anchor,
    status: message.isError ? "error" : "success",
    output: { text },
    error: message.isError ? { code: "tool_error", message: text.slice(0, 2000) } : undefined,
    endedAt: toEpochMs(source.timestamp),
    historyContent,
  };
}
