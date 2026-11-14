import { CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "../zcode-agent/zcodeAgent.js";
import type { ConversationShareRowsRead } from "./conversationShareHistoryRows.js";
import {
  ConversationShareHistoryError,
  ShareHistoryBudget,
} from "./conversationShareHistoryPolicy.js";

/** Explicit non-nek complete-projection contract only. Never selected by capability probing/failure. */
export async function readLegacyShareRows(
  target: ZCodeAgentSessionTarget,
  agent: Pick<IZCodeAgentService, "conversationRowsRangeV4">,
  budget: ShareHistoryBudget,
): Promise<ConversationShareRowsRead> {
  const rows = new Map<number, ConversationRow>();
  let beforeRowId: number | undefined;
  let revision: number | undefined;
  let logEpoch: string | undefined;
  let seq: number | undefined;
  while (true) {
    const result = await budget.read(() =>
      agent.conversationRowsRangeV4({
        ...target,
        ...(beforeRowId === undefined ? {} : { beforeRowId }),
        limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
      }),
    );
    if (
      !result ||
      !Array.isArray(result.rows) ||
      typeof result.hasMore !== "boolean" ||
      typeof result.atLogEpoch !== "string" ||
      !Number.isSafeInteger(result.atRevision)
    )
      throw new ConversationShareHistoryError("history_invalid_page");
    if (
      (revision !== undefined && result.atRevision !== revision) ||
      (logEpoch !== undefined && result.atLogEpoch !== logEpoch) ||
      (seq !== undefined && result.atSeq !== seq)
    )
      throw new ConversationShareHistoryError("history_stale");
    revision = result.atRevision;
    logEpoch = result.atLogEpoch;
    seq = result.atSeq;
    let previous = -Infinity;
    for (const row of result.rows) {
      if (
        !Number.isSafeInteger(row.rowId) ||
        row.rowId <= previous ||
        (beforeRowId !== undefined && row.rowId >= beforeRowId) ||
        rows.has(row.rowId)
      )
        throw new ConversationShareHistoryError("history_invalid_page");
      if (rows.size >= CONVERSATION_ARCHIVE_LIMITS.rows)
        throw new ConversationShareHistoryError("history_budget_exceeded");
      previous = row.rowId;
      rows.set(row.rowId, row);
    }
    if (!result.hasMore) break;
    const first = result.rows[0]?.rowId;
    if (first === undefined || (beforeRowId !== undefined && first >= beforeRowId))
      throw new ConversationShareHistoryError("history_invalid_page");
    beforeRowId = first;
  }
  const ordered = [...rows.values()].sort((a, b) => a.rowId - b.rowId);
  const turnOrdinals = new Map<string, number>();
  for (const row of ordered)
    if (row.kind === "turnHeader" && row.productTurnId && !turnOrdinals.has(row.productTurnId))
      turnOrdinals.set(row.productTurnId, turnOrdinals.size + 1);
  return { rows: ordered, revision: revision!, logEpoch: logEpoch!, turnOrdinals };
}
