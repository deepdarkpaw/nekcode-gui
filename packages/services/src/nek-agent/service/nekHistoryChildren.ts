import type {
  NekHistoryResponseData,
  NekHistorySubagentDirectory,
  NekHistorySubagentRecord,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import { NEK_STATUS_FRAME_MAX_SUBAGENTS } from "@zcode/shared/nek-protocol";
import { historyResult, NekHistoryReadError } from "./nekHistoryRpc.js";

export function historyChildDirectory(
  value: NekHistoryResponseData["read_history_subagent"],
): NekHistorySubagentDirectory {
  const result = historyResult(value);
  if (!("kind" in result) || result.kind !== "subagents")
    throw new NekHistoryReadError(
      "INVALID_RESPONSE",
      "nek returned a single child for a directory read",
    );
  return result;
}

/** Keep bounded persisted IDs separate from legacy live records: no fabricated background/model facts. */
export function historyChildPreview(
  directory: NekHistorySubagentDirectory,
  live: readonly NekSubagentRecord[],
) {
  const liveById = new Map(live.map((record) => [record.id, record]));
  const items = directory.subagents.map((record): NekHistorySubagentRecord => {
    const current = liveById.get(record.id);
    return {
      id: record.id,
      spawnEntryId: record.spawnEntryId,
      spawnPosition: record.spawnPosition,
      sessionFile: record.sessionFile,
      type: current?.type ?? record.type,
      description: record.description,
      status: current?.status ?? (record.status === "running" ? "aborted" : record.status),
      model: current ? current.model : record.model,
      startedAt: record.startedAt,
      endedAt: current ? current.endedAt : record.endedAt,
      detached: record.detached,
    };
  });
  if (items.length > NEK_STATUS_FRAME_MAX_SUBAGENTS)
    throw new NekHistoryReadError(
      "RESPONSE_LIMIT",
      "nek child directory exceeded the requested status page",
    );
  return {
    total: directory.total,
    loaded: items.length,
    complete: !directory.hasMore && items.length === directory.total,
    items,
    hasMore: directory.hasMore,
    nextCursor: directory.nextCursor,
  };
}
