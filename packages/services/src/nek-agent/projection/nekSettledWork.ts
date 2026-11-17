import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { NekProjectionStore } from "./nekProjectionStore.js";

/** 已结束主轮没有后续工具结果：只收口未完成行，不伪造成功，也不触碰独立后台工作。 */
export function settleNekWorkRow(row: ConversationRow, endedAt?: number): ConversationRow {
  if (
    row.kind === "toolCall" &&
    row.backgrounded !== true &&
    (row.status === "inputStreaming" || row.status === "running")
  ) {
    return { ...row, status: "cancelled", ...(endedAt === undefined ? {} : { endedAt }) };
  }
  if ((row.kind === "reasoning" || row.kind === "assistantText") && row.state === "streaming")
    return { ...row, state: "interrupted" };
  return row;
}

/** 请求失败立即收口所属工作，不等待整轮重试结束，也不触碰其它 response 或后台工具。 */
export function settleFailedAssistantResponse(
  ctx: {
    store: Pick<NekProjectionStore, "window" | "update">;
    now: () => number;
    assistantResponseKey?: string;
  },
  stopReason: unknown,
  responseKey = ctx.assistantResponseKey,
): void {
  if (!responseKey || (stopReason !== "error" && stopReason !== "aborted")) return;
  const endedAt = ctx.now();
  for (const row of ctx.store.window) {
    if (
      (row.kind !== "toolCall" && row.kind !== "reasoning" && row.kind !== "assistantText") ||
      row.assistantResponseId !== responseKey
    )
      continue;
    const settled = settleNekWorkRow(row, endedAt);
    if (settled !== row) ctx.store.update(row.rowId, () => settled);
  }
}

/** 历史和实时走同一收口语义；按 turnHeader 的真实终态一次线性扫描。 */
export function settleInactiveNekWorkRows(rows: ConversationRow[]): void {
  const endedTurns = new Map(
    rows.flatMap((row) =>
      row.kind === "turnHeader" && row.state !== "running"
        ? [[row.turnId, row.endedAt] as const]
        : [],
    ),
  );
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (endedTurns.has(row.turnId)) rows[index] = settleNekWorkRow(row, endedTurns.get(row.turnId));
  }
}
