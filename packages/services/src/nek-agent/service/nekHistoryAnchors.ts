import type {
  NekHistoryEntry,
  NekHistoryResult,
  NekHistorySubagent,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { validateHistoryDisplay } from "../projection/nekHistoryDisplay.js";
import { extractSubagentsFromToolResult } from "../projection/nekSubagentRecords.js";
import { historyResult, NekHistoryReadError } from "./nekHistoryRpc.js";

/** Verify original spawn metadata before projecting a resume/update as a child row.
 * The current CLI record lacks owning turn/parentToolCallId outside the loaded window;
 * explicitly reject that gap rather than moving the child to the current user round.
 */
export async function verifyHistorySpawnAnchors(
  entries: NekHistoryEntry[],
  lookup: (id: string) => Promise<NekHistoryResult<NekHistorySubagent>>,
  anchors: readonly ConversationRow[] = [],
): Promise<void> {
  const ids = new Set<string>();
  for (const source of entries) {
    if (source.omissions.length) continue;
    const entry: NekSessionEntry = validateHistoryDisplay(source.entry);
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    for (const { record } of extractSubagentsFromToolResult(
      entry.message.toolName,
      entry.message.toolCallId,
      entry.message.details,
    ))
      ids.add(record.id);
  }
  if (ids.size > 50)
    throw new NekHistoryReadError(
      "INDEX_LIMIT",
      "nek history page has more than 50 child identities; request a smaller page",
    );
  const sourceIds = new Set(entries.map((entry) => entry.id));
  for (const id of ids) {
    const { subagent } = historyResult(await lookup(id));
    if (
      sourceIds.has(subagent.spawnEntryId) ||
      anchors.some((row) => row.kind === "subagent" && row.childSessionId === id)
    )
      continue;
    throw new NekHistoryReadError(
      "HISTORY_ANCHOR_REQUIRED",
      `Subagent ${id} original spawn is outside this page; CLI history seed must include spawn turnId and parentToolCallId (no whole-history fallback)`,
    );
  }
}
