import {
  PROTOCOL_V4_LIMITS,
  type ConversationSnapshot,
  type V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";

/** ZCodium publisher 的 wire 尾窗：只裁传输视图，不改变同源分页所需的投影与历史水位。 */
export function nekConversationWireSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  const limit = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  if (snapshot.rows.window.length <= limit) return snapshot;
  return {
    ...snapshot,
    rows: { ...snapshot.rows, window: snapshot.rows.window.slice(-limit) },
  };
}

/** 复用 ZCodium getRowsRange 的数值游标语义；游标不必对应当前仍存在的行。 */
export function nekConversationRowsRange(
  snapshot: ConversationSnapshot,
  params: { beforeRowId?: number; limit: number },
): V4ConversationRowsRangeResult {
  const limit = Math.max(1, Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit));
  const { beforeRowId } = params;
  const eligible =
    beforeRowId === undefined
      ? snapshot.rows.window
      : snapshot.rows.window.filter((row) => row.rowId < beforeRowId);
  const rows = eligible.slice(-limit);
  return {
    rows,
    atSeq: snapshot.seq,
    atRevision: snapshot.revision,
    atLogEpoch: snapshot.logEpoch,
    hasMore: eligible.length > rows.length,
  };
}
