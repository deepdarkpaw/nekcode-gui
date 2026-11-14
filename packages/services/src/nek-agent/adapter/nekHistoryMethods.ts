import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  IZCodeAgentService,
  ZCodeAgentConversationHistoryTarget,
} from "../../zcode-agent/zcodeAgent.js";
import {
  historyMetadata,
  historyTurn,
  projectHistory,
} from "../projection/nekHistoryProjection.js";
import { verifyHistorySpawnAnchors } from "../service/nekHistoryAnchors.js";
import { boundHistoryResult, NekHistoryReadError } from "../service/nekHistoryRpc.js";
import type { NekHistoryReadContext } from "../service/nekHistoryService.js";
import type { NekAgentServiceAdapterLegacyTarget } from "./nekAgentServiceAdapterLegacySupport.js";

type HistoryMethods = Pick<
  IZCodeAgentService,
  | "conversationHistoryPageV4"
  | "conversationHistoryTurnV4"
  | "conversationHistoryDirectoryV4"
  | "conversationHistoryContentV4"
>;

/** Never write persisted page bytes into the live owner. Existing live entities win on overlap. */
function preserveLive(rows: ConversationRow[], context: NekHistoryReadContext): ConversationRow[] {
  const live = new Map(
    context.projector
      .snapshot()
      .rows.window.filter((row) => row.entityId)
      .map((row) => [row.entityId, row]),
  );
  return rows.map((row) => {
    const current = live.get(row.entityId);
    if (current?.kind === "subagent" && row.kind === "subagent")
      return {
        ...current,
        rowId: row.rowId,
        turnId: row.turnId,
        parentToolCallId: row.parentToolCallId,
      };
    return current ? { ...current, rowId: row.rowId, turnId: row.turnId } : row;
  });
}
export function createNekHistoryMethods(owner: NekAgentServiceAdapterLegacyTarget): HistoryMethods {
  const read = async <T>(
    input: ZCodeAgentConversationHistoryTarget,
    run: (context: NekHistoryReadContext) => Promise<T>,
  ) => {
    const binding = await owner.ensureNekSessionBinding(input, input.sessionId);
    return await owner.service.runHistoryRead(binding.sessionKey, input.subagentId, run);
  };
  return {
    conversationHistoryPageV4: (input) =>
      read(input, async (context) => {
        const { beforeCursor, afterCursor, aroundEntryId, turnLimit = 20 } = input;
        const page = await context.read({
          type: "read_history_page",
          beforeCursor,
          afterCursor,
          aroundEntryId,
          turnLimit,
        });
        if (
          !input.subagentId &&
          !beforeCursor &&
          !afterCursor &&
          !context.projector.acceptsHistoryPage(page)
        )
          throw new NekHistoryReadError(
            "STALE_CURSOR",
            "history branch changed; rebuild the bounded snapshot before reading this target",
          );
        const scope = input.subagentId
          ? `${page.sessionId}\0${page.branchRevision}`
          : page.sessionId;
        const anchors = context.projector.historyAnchors(scope);
        await verifyHistorySpawnAnchors(
          page.entries,
          (subagentId) => context.read({ type: "read_history_subagent", subagentId }),
          anchors,
        );
        const rows = projectHistory({
          sessionId: page.sessionId,
          turns: page.turns,
          entries: page.entries,
          seed: page.seed,
          anchors,
        });
        const result = boundHistoryResult({
          rows: input.subagentId ? rows : preserveLive(rows, context),
          history: historyMetadata(page),
          ...context.watermark,
        });
        context.projector.rememberHistoryAnchors(
          scope,
          `${page.branchRevision}:${page.entries[0]?.position}:${page.entries.at(-1)?.position}`,
          result.rows,
        );
        return result;
      }),
    conversationHistoryTurnV4: (input) =>
      read(input, async (context) => {
        const page = await context.read({
          type: "read_history_turn",
          turnId: input.turnId,
          cursor: input.cursor,
        });
        const scope = input.subagentId
          ? `${page.sessionId}\0${page.branchRevision}`
          : page.sessionId;
        const anchors = context.projector.historyAnchors(scope);
        await verifyHistorySpawnAnchors(
          page.entries,
          (subagentId) => context.read({ type: "read_history_subagent", subagentId }),
          anchors,
        );
        const rows = projectHistory({
          sessionId: page.sessionId,
          turns: [
            {
              ...page.turn,
              continuationCursor: page.continuationCursor ?? page.turn.continuationCursor,
            },
          ],
          entries: page.entries,
          anchors,
        });
        const result = boundHistoryResult({
          rows: input.subagentId ? rows : preserveLive(rows, context),
          turn: historyTurn(page.turn),
          hasMore: page.hasMore,
          continuationCursor: page.continuationCursor,
          ...context.watermark,
        });
        context.projector.rememberHistoryAnchors(
          scope,
          `${page.branchRevision}:${page.turn.id}:${page.entries[0]?.position}:${page.entries.at(-1)?.position}`,
          result.rows,
        );
        return result;
      }),
    conversationHistoryDirectoryV4: (input) =>
      read(input, async (context) => {
        const { query, cursor, direction, aroundEntryId, limit } = input;
        const page = await context.read({
          type: "read_history_directory",
          query,
          cursor,
          direction,
          aroundEntryId,
          limit,
        });
        return boundHistoryResult({
          items: page.items,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          totalTurns: page.totalTurns,
          ...context.watermark,
        });
      }),
    conversationHistoryContentV4: (input) =>
      read(input, async (context) => {
        const page = await context.read({
          type: "read_history_content",
          ref: input.ref,
          offset: input.offset,
          limit: input.limit,
        });
        return boundHistoryResult({
          ref: page.ref,
          offset: page.offset,
          totalBytes: page.totalBytes,
          mediaType: page.mediaType,
          encoding: page.encoding,
          data: page.data,
          nextOffset: page.nextOffset,
          ...context.watermark,
        });
      }),
  };
}
