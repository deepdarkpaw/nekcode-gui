import type { ConversationRow, ReasoningRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";

/** Request identity prevents retaining a previous branch's timing for a different final response. */
function turnKeys(rows: readonly ConversationRow[]): Map<string, string> {
  const starts = new Map<string, number>();
  const responses = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "turnHeader") starts.set(row.turnId, row.startedAt);
    if (
      (row.kind === "assistantText" || row.kind === "reasoning" || row.kind === "toolCall") &&
      row.assistantResponseId
    ) {
      responses.set(row.turnId, row.assistantResponseId);
    }
  }
  const keys = new Map<string, string>();
  for (const [turn, response] of responses) {
    const start = starts.get(turn);
    if (start !== undefined) keys.set(turn, `${start}:${response}`);
  }
  return keys;
}

function reasoningKey(row: ReasoningRow): string | undefined {
  const index = row.entityId?.match(/:thinking:(\d+)$/)?.[1];
  return index !== undefined && row.assistantResponseId
    ? `${row.assistantResponseId}:${index}`
    : undefined;
}

/** Reuse already observed lifecycle facts during history reload; never invent missing history times. */
export function preserveObservedTiming(
  rows: ConversationRow[],
  previousRows: readonly ConversationRow[],
): ConversationRow[] {
  const oldKeys = turnKeys(previousRows);
  const nextKeys = turnKeys(rows);
  const completed = new Map<string, TurnHeaderRow>();
  const thinking = new Map<string, ReasoningRow>();
  for (const row of previousRows) {
    if (row.kind === "turnHeader" && row.state !== "running" && row.endedAt !== undefined) {
      const key = oldKeys.get(row.turnId);
      if (key) completed.set(key, row);
    }
    if (row.kind === "reasoning" && row.durationMs !== undefined) {
      const key = reasoningKey(row);
      if (key) thinking.set(key, row);
    }
  }
  return rows.map((row) => {
    if (row.kind === "turnHeader" && row.state !== "running") {
      const key = nextKeys.get(row.turnId);
      const previous = key ? completed.get(key) : undefined;
      if (previous) return { ...row, endedAt: previous.endedAt };
    }
    if (row.kind === "reasoning") {
      const key = reasoningKey(row);
      const previous = key ? thinking.get(key) : undefined;
      if (previous?.text === row.text)
        return { ...row, createdAt: previous.createdAt, durationMs: previous.durationMs };
    }
    return row;
  });
}
