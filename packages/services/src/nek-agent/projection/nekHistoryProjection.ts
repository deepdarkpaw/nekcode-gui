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
import { extractSubagentsFromToolResult } from "./nekSubagentRecords.js";
import {
  buildAssistantTextRow,
  buildTurnHeaderRow,
  buildUserInputRow,
  toEpochMs,
} from "./nekRows.js";

import { HISTORY_ROW_STRIDE as STRIDE, historyRowId } from "./nekHistoryIdentity.js";
import { partialMessageRows, partialCustomRows } from "./nekHistoryPartialMessages.js";
import { partialToolCalls, partialToolResult, partialAssistantError } from "./nekHistoryPartial.js";
export { historyRowId } from "./nekHistoryIdentity.js";
export const historyTurn = (turn: NekHistoryTurn): ConversationHistoryTurn => ({
  turnId: turn.id,
  userEntryId: turn.userEntryId,
  position: turn.position,
  preview: turn.preview,
  ...(turn.continuationCursor ? { continuationCursor: turn.continuationCursor } : {}),
});
export function historyMetadata(page: NekHistoryPage): ConversationHistory {
  return {
    branchRevision: page.branchRevision,
    totalTurns: page.totalTurns,
    turns: page.turns.map(historyTurn),
    olderCursor: page.olderCursor,
    newerCursor: page.newerCursor,
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
  };
}

/** All resolver keys are derived from source entry/block identities, never page-local allocation. */
function identityLayout(
  turn: NekHistoryTurn,
  sources: NekHistoryEntry[],
  complete: NekSessionEntry[],
  anchors: readonly ConversationRow[],
) {
  const ids = new Map<string, number>([[turn.id, historyRowId(turn.header.position, 0)]]);
  const wrappers = new Map(sources.map((source) => [source.id, source]));
  for (const row of anchors) if (row.entityId) ids.set(row.entityId, row.rowId);
  for (const entry of complete) {
    const wrapper = wrappers.get(entry.id)!;
    const pos = wrapper.position;
    ids.set(`entry:${entry.id}`, historyRowId(pos, 2));
    ids.set(`entry:${entry.id}:user`, historyRowId(pos, 1));
    if (entry.type === "custom_message") {
      ids.set(`custom:${entry.id}:${entry.customType}`, historyRowId(pos, 2));
      if (typeof entry.details === "object" && entry.details !== null && "plan" in entry.details) {
        const plan = entry.details.plan;
        if (typeof plan === "object" && plan !== null && "revision" in plan)
          ids.set(`entry:${entry.id}:plan:${plan.revision}`, historyRowId(pos, 2));
      }
    }
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

/** Omitted fields can include any subtree/root. Keep an explicit deferred row, not fake completion. */
function deferred(source: NekHistoryEntry): ConversationRow {
  const identity = {
    rowId: historyRowId(source.position, source.role === "user" ? 1 : STRIDE - 2),
    turnId: source.turnId,
    entityId: source.role === "user" ? `entry:${source.id}:user` : `history-deferred:${source.id}`,
    createdAt: toEpochMs(source.timestamp),
  };
  const row =
    source.role === "user"
      ? buildUserInputRow(identity, { text: source.preview })
      : buildAssistantTextRow(identity, { text: source.preview, state: "deferred" });
  return {
    ...row,
    historyContent: source.omissions.map((omission) => ({ ...omission, entryId: source.id })),
  };
}

/** Request-local projection: no body cache and no prefix traversal. Headers survive continuation cuts. */
export function projectHistory(input: {
  sessionId: string;
  turns: NekHistoryTurn[];
  entries: NekHistoryEntry[];
  nekState?: NekState;
  seed?: NekHistorySelection;
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
      [turn.header.id, turn.header],
      ...input.entries
        .filter((entry) => entry.turnId === turn.id)
        .map((entry) => [entry.id, entry] as const),
    ]);
    const sources = [...byId.values()].sort((a, b) => a.position - b.position);
    const complete = sources
      .filter((entry) => entry.omissions.length === 0)
      .map((source) => {
        const entry = validateHistoryDisplay(source.entry);
        if (entry.id !== source.id || entry.type !== source.type)
          throw new Error("nek history display identity mismatch");
        return entry;
      });
    const partialCalls = sources.flatMap(partialToolCalls);
    const partialMessages = sources.flatMap((source) => [
      ...partialMessageRows(source, input.sessionId),
      ...partialCustomRows(source),
    ]);
    for (const source of sources)
      if (
        source.role === "user" &&
        source.omissions.length &&
        !partialMessages.some((row) => row.entityId === `entry:${source.id}:user`)
      )
        partialMessages.push(deferred(source));
    anchors.push(...partialCalls, ...partialMessages);
    const resolve = identityLayout(turn, sources, complete, anchors);
    const subagentAnchors = new Map(
      anchors.flatMap((row) =>
        row.kind === "subagent" && row.childSessionId
          ? [
              [
                row.childSessionId,
                { turnId: row.turnId, parentToolCallId: row.parentToolCallId },
              ] as const,
            ]
          : [],
      ),
    );
    const projected = projectEntries({
      sessionId: input.sessionId,
      entries: complete,
      historyLayout: {
        turnId: turn.id,
        resolve,
        subagentAnchors,
        selection,
        partial:
          Boolean(turn.continuationCursor) || sources.some((source) => source.omissions.length > 0),
      },
      nekState: input.nekState,
      existing: { rows: anchors, byEntity: new Map(), nextRowId: 1 },
    });
    for (const entry of complete) {
      if (entry.type === "model_change")
        selection = { ...selection, provider: entry.provider, model: entry.modelId };
      if (entry.type === "thinking_level_change")
        selection = { ...selection, thought: entry.thinkingLevel };
    }
    const actualUser = turn.header.entry?.message;
    const startedAt =
      typeof actualUser === "object" &&
      actualUser !== null &&
      "timestamp" in actualUser &&
      typeof actualUser.timestamp === "number"
        ? actualUser.timestamp
        : toEpochMs(turn.header.timestamp);
    const lastResponse = sources.findLast((source) => source.role === "assistant")?.entry?.message;
    const stop =
      typeof lastResponse === "object" && lastResponse !== null && "stopReason" in lastResponse
        ? lastResponse.stopReason
        : undefined;
    projected.rows = projected.rows.map((row) =>
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
            ...(sources.some((source) => source.omissions.length) || turn.continuationCursor
              ? { endedAt: undefined }
              : {}),
          }
        : row,
    );
    for (const row of [...partialCalls, ...partialMessages]) result.set(row.rowId, row);
    for (const row of projected.rows) result.set(row.rowId, row);
    anchors.push(
      ...projected.rows.filter((row) => row.kind === "toolCall" || row.kind === "subagent"),
    );
    for (const source of sources) {
      const row = partialToolResult(source, anchors);
      if (!row) continue;
      const later = sources.some(
        (candidate) =>
          candidate.position > source.position &&
          !candidate.omissions.length &&
          candidate.type === "message" &&
          typeof candidate.entry.message === "object" &&
          candidate.entry.message !== null &&
          "toolCallId" in candidate.entry.message &&
          candidate.entry.message.toolCallId === row.toolCallId,
      );
      if (!later) {
        result.set(row.rowId, row);
        anchors.push(row);
      }
    }
    if (!projected.rows.some((row) => row.kind === "turnHeader")) {
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
    for (const source of sources)
      if (source.omissions.length) {
        if (["custom", "usage", "label", "context_edit"].includes(source.type)) continue;
        if (source.type === "custom_message" && source.entry?.display === false) {
          if (source.entry.customType === "nek.attachments") {
            const owner = [...result.values()].find(
              (row) => row.kind === "userInput" && row.entityId === `entry:${source.parentId}:user`,
            );
            if (!owner)
              throw new Error(
                "nek HISTORY_ANCHOR_REQUIRED: deferred attachments have no owning user",
              );
            result.set(owner.rowId, {
              ...owner,
              historyContent: [
                ...(owner.historyContent ?? []),
                ...source.omissions.map((ref) => ({ ...ref, entryId: source.id })),
              ],
            });
          }
          continue;
        }
        if (source.type === "custom_message" && source.entry?.display !== true)
          throw new Error(
            "nek HISTORY_DISPLAY_CONTEXT_REQUIRED: root custom entry has no visibility seed",
          );
        const error = partialAssistantError(source);
        if (error) result.set(error.rowId, error);
        if (
          [...result.values()].some(
            (row) =>
              row.kind !== "timelineMarker" &&
              row.historyContent?.some((ref) => ref.entryId === source.id),
          )
        )
          continue;
        const row = deferred(source);
        result.set(row.rowId, row);
      }
    const headerId = historyRowId(turn.header.position, 0);
    const header = result.get(headerId);
    if (header?.kind === "turnHeader" && (stop === "error" || stop === "aborted"))
      result.set(headerId, {
        ...header,
        state: stop === "error" ? "failed" : "completedInterrupted",
      });
  }
  return [...result.values()]
    .sort((a, b) => a.rowId - b.rowId)
    .map((row) => conversationRowSchema.parse(row));
}
