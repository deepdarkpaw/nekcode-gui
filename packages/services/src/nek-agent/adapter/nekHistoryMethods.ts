import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  IZCodeAgentService,
  ZCodeAgentConversationHistoryTarget,
} from "../../zcode-agent/zcodeAgent.js";
import { historyMetadata, projectHistory } from "../projection/nekHistoryProjection.js";
import { prepareHistoryPage } from "../service/nekHistoryAnchors.js";
import {
  boundHistoryResult,
  historyResultBytes,
  HISTORY_RENDER_MAX_BYTES,
  NekHistoryReadError,
  smallerHistoryTurnLimit,
} from "../service/nekHistoryRpc.js";
import type { NekHistoryReadContext } from "../service/nekHistoryService.js";
import type { NekAgentServiceAdapterLegacyTarget } from "./nekAgentServiceAdapterLegacySupport.js";

function assertObservedEntries(
  entries: readonly { position: number }[],
  context: NekHistoryReadContext,
  child: boolean,
): void {
  if (
    !child &&
    !context.readonly &&
    context.observedEntries !== undefined &&
    entries.some((entry) => entry.position >= context.observedEntries!)
  )
    throw new NekHistoryReadError(
      "STALE_CURSOR",
      "persisted history is ahead of the captured live owner; refetch after the live checkpoint",
    );
}

type HistoryMethods = Pick<
  IZCodeAgentService,
  "conversationHistoryPageV4" | "conversationHistoryDirectoryV4"
>;

/** Overlay the CAPTURED emitted owner view, never unflushed bytes that a later delta will append. */
function preserveLive(rows: ConversationRow[], context: NekHistoryReadContext): ConversationRow[] {
  const live = new Map(
    context.snapshot.rows.window.filter((row) => row.entityId).map((row) => [row.entityId, row]),
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
/** One source read of complete turns, projected and measured; the caller owns the byte budget. */
async function readProjectedPage(
  context: NekHistoryReadContext,
  input: Parameters<IZCodeAgentService["conversationHistoryPageV4"]>[0],
  turnLimit: number,
) {
  const { beforeCursor, afterCursor, aroundEntryId, observationCursor } = input;
  const page = await context.read({
    type: "read_history_page",
    beforeCursor,
    afterCursor,
    aroundEntryId,
    turnLimit,
    observationCursor,
  });
  assertObservedEntries(
    [...page.entries, ...page.turns.map((turn) => turn.header)],
    context,
    Boolean(input.subagentId),
  );
  if (
    !input.subagentId &&
    !beforeCursor &&
    !afterCursor &&
    !observationCursor &&
    !context.projector.acceptsHistoryPage(page)
  )
    throw new NekHistoryReadError(
      "STALE_CURSOR",
      "history branch changed; rebuild the bounded snapshot before reading this target",
    );
  const scope = input.subagentId ? `${page.sessionId}\0${page.branchRevision}` : page.sessionId;
  const anchors =
    input.subagentId || context.projector.acceptsHistoryPage(page)
      ? context.projector.historyAnchors(scope)
      : [];
  const prepared = await prepareHistoryPage(page, context.read, () => anchors);
  const rows = projectHistory({ ...prepared, anchors });
  const result = {
    rows: input.subagentId ? rows : preserveLive(rows, context),
    history: historyMetadata(page),
    ...context.watermark,
    branchRevision: page.branchRevision,
    observationCursor: page.observationCursor,
  };
  return { page, result, bytes: historyResultBytes(result), scope };
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
        let turnLimit = input.turnLimit ?? 20;
        for (;;) {
          const { page, result, bytes, scope } = await readProjectedPage(context, input, turnLimit);
          if (bytes > HISTORY_RENDER_MAX_BYTES && page.turns.length > 1) {
            turnLimit = smallerHistoryTurnLimit(page.turns.length, bytes);
            continue;
          }
          boundHistoryResult(result, bytes);
          context.projector.rememberHistoryAnchors(
            scope,
            `${page.branchRevision}:${page.entries[0]?.position}:${page.entries.at(-1)?.position}`,
            result.rows,
          );
          return result;
        }
      }),
    conversationHistoryDirectoryV4: (input) =>
      read(input, async (context) => {
        const { query, cursor, direction, aroundEntryId, limit, observationCursor } = input;
        const page = await context.read({
          type: "read_history_directory",
          query,
          cursor,
          direction,
          aroundEntryId,
          limit,
          observationCursor,
        });
        return boundHistoryResult({
          items: page.items,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          totalTurns: page.totalTurns,
          ...context.watermark,
          branchRevision: page.branchRevision,
          observationCursor: page.observationCursor,
        });
      }),
  };
}
