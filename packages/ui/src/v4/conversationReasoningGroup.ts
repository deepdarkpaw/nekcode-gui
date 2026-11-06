import type { ReasoningRow } from "@zcode/shared/zcode-protocol-v4";

/** Display-only merge; canonical rows and their individual timing remain unchanged. */
export function buildReasoningGroup(rows: ReasoningRow[]) {
  const first = rows[0]!;
  const durationMs = rows.every((row) => row.durationMs !== undefined)
    ? rows.reduce((total, row) => total + row.durationMs!, 0)
    : undefined;
  const row: ReasoningRow = {
    ...first,
    text: rows.map((entry) => entry.text).join("\n\n"),
    state: rows.some((entry) => entry.state === "streaming") ? "streaming" : "complete",
    assistantResponseId: undefined,
    durationMs,
  };
  return { kind: "reasoningGroup" as const, key: `row:${first.rowId}`, row, rows };
}
