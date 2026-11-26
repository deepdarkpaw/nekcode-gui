import type {
  NekHistoryEntry,
  NekHistoryPage,
  NekHistorySelection,
  NekHistoryTurn,
  NekSessionEntry,
  NekState,
} from "@zcode/shared/nek-protocol";
import type {
  ConversationHistory,
  ConversationHistoryTurn,
  ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import { projectEntries } from "./nekEntryProjection.js";
import { validateHistoryDisplay } from "./nekHistoryDisplay.js";
import { nekPlanArtifactEntity } from "./nekPlanArtifact.js";
import { extractSubagentsFromToolResult } from "./nekSubagentRecords.js";
import { buildTurnHeaderRow, toEpochMs } from "./nekRows.js";
import { HISTORY_ROW_STRIDE as STRIDE, historyRowId } from "./nekHistoryIdentity.js";
export { historyRowId } from "./nekHistoryIdentity.js";

const historyTurn = (turn: Omit<NekHistoryTurn, "header">): ConversationHistoryTurn => ({
  turnId: turn.id,
  userEntryId: turn.userEntryId,
  position: turn.position,
  preview: turn.preview,
});
export function historyMetadata(
  page: Pick<
    NekHistoryPage,
    | "branchRevision"
    | "observationCursor"
    | "totalTurns"
    | "olderCursor"
    | "newerCursor"
    | "hasOlder"
    | "hasNewer"
  > & { turns: Array<Omit<NekHistoryTurn, "header">> },
): ConversationHistory {
  return {
    branchRevision: page.branchRevision,
    // Source observation proves append-only progress independently of the host live watermark.
    observationCursor: page.observationCursor,
    totalTurns: page.totalTurns,
    turns: page.turns.map(historyTurn),
    olderCursor: page.olderCursor,
    newerCursor: page.newerCursor,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
  };
}

/** All resolver keys derive from source entry/block identities, never page-local allocation. */
function identityLayout(
  turn: NekHistoryTurn,
  sources: NekHistoryEntry[],
  entries: NekSessionEntry[],
  anchors: readonly ConversationRow[],
) {
  const ids = new Map<string, number>([[turn.id, historyRowId(turn.header.position, 0)]]);
  const wrappers = new Map(sources.map((source) => [source.id, source]));
  for (const row of anchors) if (row.entityId) ids.set(row.entityId, row.rowId);
  for (const entry of entries) {
    const wrapper = wrappers.get(entry.id)!;
    const pos = wrapper.position;
    ids.set(`entry:${entry.id}`, historyRowId(pos, 2));
    ids.set(`entry:${entry.id}:user`, historyRowId(pos, 1));
    ids.set(nekPlanArtifactEntity(entry.id), historyRowId(pos, 3));
    if (entry.type === "custom_message")
      ids.set(`custom:${entry.id}:${entry.customType}`, historyRowId(pos, 2));
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "bashExecution") ids.set(`entry:${entry.id}:bash`, historyRowId(pos, 2));
    ids.set(`entry:${entry.id}:branchSummary`, historyRowId(pos, 2));
    ids.set(`entry:${entry.id}:compactionSummary`, historyRowId(pos, 2));
    if (message.role === "assistant") {
      ids.set(`model-error:${entry.id}`, historyRowId(pos, STRIDE - 3));
      message.content.forEach((block, index) => {
        const slot = 16 + index * 4;
        if (slot + 2 >= STRIDE - 4) throw new Error("nek history content-block identity overflow");
        ids.set(`entry:${entry.id}:text:${index}`, historyRowId(pos, slot));
        ids.set(`entry:${entry.id}:thinking:${index}`, historyRowId(pos, slot + 1));
        if (block.type === "toolCall") ids.set(`tool:${block.id}`, historyRowId(pos, slot + 2));
      });
    }
    if (
      message.role === "toolResult" &&
      wrapper.toolCallOrigin === null &&
      !ids.has(`tool:${message.toolCallId}`)
    )
      ids.set(`tool:${message.toolCallId}`, historyRowId(pos, 2));
    if (message.role === "toolResult" && message.toolName === "subagent") {
      const records = extractSubagentsFromToolResult(
        message.toolName,
        message.toolCallId,
        message.details,
      );
      // A resumed child is not a new spawn. Known anchors always win.
      for (const { record } of records)
        if (!ids.has(`subagent:${record.id}`))
          ids.set(`subagent:${record.id}`, historyRowId(pos, STRIDE - 4));
    }
  }
  return (entity: string): number => {
    const id = ids.get(entity);
    if (id === undefined)
      throw new Error(
        `nek HISTORY_ANCHOR_REQUIRED: missing source identity for ${entity}; CLI must supply tool/spawn seed context`,
      );
    return id;
  };
}

/** Request-local projection of complete display entries. Target reads reuse admitted live anchors. */
export function projectHistory(input: {
  sessionId: string;
  turns: NekHistoryTurn[];
  entries: NekHistoryEntry[];
  nekState?: NekState;
  seed?: NekHistorySelection;
  /** Live target projection: a repeated non-user header is context, not a new selection fact. */
  targetEntryId?: string;
  anchors?: readonly ConversationRow[];
}): ConversationRow[] {
  const result = new Map<number, ConversationRow>();
  const anchors = [...(input.anchors ?? [])];
  let selection = {
    provider: input.seed?.model?.provider,
    model: input.seed?.model?.modelId,
    thought: input.seed?.thinkingLevel,
  };
  for (const turn of input.turns) {
    const byId = new Map([
      ...(!input.targetEntryId ||
      turn.header.id === input.targetEntryId ||
      turn.header.role === "user"
        ? [[turn.header.id, turn.header] as const]
        : []),
      ...input.entries
        .filter((entry) => entry.turnId === turn.id)
        .map((entry) => [entry.id, entry] as const),
    ]);
    const sources = [...byId.values()].sort((a, b) => a.position - b.position);
    const entries = sources.map((source) => {
      const entry = validateHistoryDisplay(source.entry);
      if (entry.id !== source.id || entry.type !== source.type)
        throw new Error("nek history display identity mismatch");
      return entry;
    });
    const resolve = identityLayout(turn, sources, entries, anchors);
    const subagentAnchors = new Map(
      anchors.flatMap((row) =>
        row.kind === "subagent" && row.childSessionId
          ? [
              [
                `subagent:${row.childSessionId}`,
                { turnId: row.turnId, parentToolCallId: row.parentToolCallId },
              ] as const,
            ]
          : [],
      ),
    );
    const projected = projectEntries({
      sessionId: input.sessionId,
      entries,
      historyLayout: { turnId: turn.id, resolve, subagentAnchors, selection },
      nekState: input.nekState,
      // An ordered live target is a current tool fact, not a cold registry restore.
      isSessionRunning: input.targetEntryId !== undefined,
      existing: { rows: anchors, byEntity: new Map(), nextRowId: 1 },
    });
    for (const entry of entries) {
      if (entry.type === "model_change")
        selection = { ...selection, provider: entry.provider, model: entry.modelId };
      if (entry.type === "thinking_level_change")
        selection = { ...selection, thought: entry.thinkingLevel };
    }
    const actualUser = turn.header.entry.message;
    const startedAt =
      typeof actualUser === "object" &&
      actualUser !== null &&
      "timestamp" in actualUser &&
      typeof actualUser.timestamp === "number"
        ? actualUser.timestamp
        : toEpochMs(turn.header.timestamp);
    const lastResponse = sources.findLast((source) => source.role === "assistant")?.entry.message;
    const stop =
      typeof lastResponse === "object" && lastResponse !== null && "stopReason" in lastResponse
        ? lastResponse.stopReason
        : undefined;
    for (const row of projected.rows) {
      result.set(
        row.rowId,
        row.kind === "turnHeader"
          ? {
              ...row,
              startedAt,
              createdAt: startedAt,
              ...(stop === "error"
                ? { state: "failed" as const }
                : stop === "aborted"
                  ? { state: "completedInterrupted" as const }
                  : stop === "pending"
                    ? { state: "running" as const }
                    : {}),
            }
          : row,
      );
    }
    anchors.push(
      ...projected.rows.filter((row) => row.kind === "toolCall" || row.kind === "subagent"),
    );
    if (projected.rows.length > 0 && !projected.rows.some((row) => row.kind === "turnHeader")) {
      const row = buildTurnHeaderRow(
        {
          rowId: historyRowId(turn.header.position, 0),
          entityId: turn.id,
          turnId: turn.id,
          createdAt: toEpochMs(turn.header.timestamp),
        },
        { state: "completedSuccess" },
      );
      result.set(row.rowId, row);
    }
  }
  return [...result.values()]
    .sort((a, b) => a.rowId - b.rowId)
    .map((row) => {
      if (!row.turnId)
        throw new Error("nek HISTORY_TURN_IDENTITY_REQUIRED: source row has no owning turn");
      return conversationRowSchema.parse({ ...row, productTurnId: row.turnId });
    });
}
