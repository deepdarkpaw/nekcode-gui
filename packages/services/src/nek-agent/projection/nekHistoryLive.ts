import type {
  NekHistoryEntry,
  NekHistoryPage,
  NekHistoryTurn,
  NekSessionEntry,
} from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { NekLiveContext } from "./nekLiveTurn.js";
import { projectHistory } from "./nekHistoryProjection.js";

/** Only the current owning header is retained; no complete source history or message cache. */
export interface NekHistoryLiveSource {
  nextPosition: number;
  baseEntries: number;
  leafId: string | null;
  turn?: NekHistoryTurn;
  aliases: Map<string, string>;
}
export function historyLiveSource(page: NekHistoryPage): NekHistoryLiveSource {
  return {
    nextPosition: page.totalEntries,
    baseEntries: page.totalEntries,
    leafId: page.leafId,
    turn: page.turns.at(-1),
    aliases: new Map(),
  };
}

/** Preserve in-progress rows/context across a compatible source rebuild; pages cannot rewind streams. */
export function mergeStreamingHistory(
  rows: ConversationRow[],
  ctx: NekLiveContext,
): ConversationRow[] {
  const merged = new Map(rows.map((row) => [row.entityId ?? row.rowId, row]));
  for (const row of ctx.store.window) {
    const active =
      row.turnId === ctx.turn?.turnId ||
      (row.kind === "toolCall" && (row.status === "running" || row.status === "inputStreaming")) ||
      (row.kind === "subagent" && row.status === "running");
    if (!active) continue;
    const persisted = merged.get(row.entityId ?? row.rowId);
    merged.set(row.entityId ?? row.rowId, persisted ? { ...row, rowId: persisted.rowId } : row);
  }
  return [...merged.values()].sort((a, b) => a.rowId - b.rowId);
}

/** Rebind only retained identities after a source replacement; never lose active stream keys. */
export function rebindStreamingHistory(
  ctx: NekLiveContext,
  previous: readonly ConversationRow[],
): void {
  const old = new Map(previous.map((row) => [row.rowId, row.entityId]));
  const current = new Map(ctx.store.window.map((row) => [row.entityId, row.rowId]));
  for (const map of [ctx.streamRows, ctx.toolRows])
    for (const [key, id] of map) {
      const next = current.get(old.get(id));
      if (next === undefined) map.delete(key);
      else map.set(key, next);
    }
  if (ctx.turn) ctx.turn.headerRowId = current.get(ctx.turn.entityId) ?? ctx.turn.headerRowId;
}

/** Reconcile a persisted append with its live message by explicit timestamp+role event identity.
 * The CLI event lacks position; derive it only for an authenticated contiguous parent append.
 * A branch discontinuity is rejected and must be rebuilt via the bounded source API.
 */
export function reconcileHistoryAppend(
  source: NekHistoryLiveSource,
  entry: NekSessionEntry,
  ctx: NekLiveContext,
): ConversationRow[] {
  if (entry.parentId !== source.leafId)
    throw new Error("nek history append is not contiguous; bounded snapshot rebuild required");
  const oldRows = [...ctx.store.window];
  const user = entry.type === "message" && entry.message.role === "user";
  const turnId = user ? `turn:${entry.id}` : (source.turn?.id ?? "preamble");
  const display: NekHistoryEntry = {
    id: entry.id,
    parentId: entry.parentId,
    position: source.nextPosition,
    turnId,
    timestamp: entry.timestamp,
    type: entry.type,
    role: entry.type === "message" ? entry.message.role : undefined,
    preview: "",
    entry: { ...entry },
    omissions: [],
  };
  const turn: NekHistoryTurn =
    user || !source.turn
      ? {
          id: turnId,
          userEntryId: user ? entry.id : null,
          position: source.nextPosition,
          preview: "",
          entryCount: 1,
          header: display,
        }
      : source.turn;
  const projected = projectHistory({
    sessionId: ctx.store.sessionId,
    turns: [turn],
    entries: [display],
    anchors: ctx.historyAnchors?.() ?? oldRows,
  });
  const aliases = new Map<string, string>();
  if (entry.type === "message") {
    const message = entry.message;
    if (message.role === "user") {
      aliases.set(`msg:${message.timestamp}:user`, `entry:${entry.id}:user`);
      aliases.set(`turn:${message.timestamp}`, turnId);
    }
    if (message.role === "bashExecution")
      aliases.set(`bash:${message.timestamp}`, `entry:${entry.id}:bash`);
    if (message.role === "assistant")
      aliases.set(`model-error:${message.timestamp}`, `model-error:${entry.id}`);
    if (message.role === "assistant")
      message.content.forEach((block, index) => {
        if (block.type === "text" || block.type === "thinking")
          aliases.set(
            `resp:${message.timestamp}:${block.type}:${index}`,
            `entry:${entry.id}:${block.type}:${index}`,
          );
      });
  }
  const canonical = new Map(projected.map((row) => [row.entityId, row]));
  const replacements = new Map<number, number>();
  const merged = new Map<string | number, ConversationRow>();
  const oldTurn =
    user && entry.type === "message" ? `turn:${entry.message.timestamp}` : ctx.turn?.turnId;
  for (const previous of oldRows) {
    const entity = previous.entityId
      ? (aliases.get(previous.entityId) ?? previous.entityId)
      : undefined;
    const persisted = canonical.get(entity);
    const row = persisted
      ? { ...previous, rowId: persisted.rowId, entityId: entity, turnId: persisted.turnId }
      : user && previous.turnId === oldTurn && oldTurn !== turnId
        ? { ...previous, turnId }
        : previous;
    replacements.set(previous.rowId, row.rowId);
    merged.set(row.entityId ?? row.rowId, row);
  }
  for (const row of projected) {
    // The repeated owning header/user is context only; never rewind a newer streaming row.
    if (!merged.has(row.entityId ?? row.rowId)) merged.set(row.entityId ?? row.rowId, row);
  }
  for (const [key, id] of ctx.streamRows) ctx.streamRows.set(key, replacements.get(id) ?? id);
  for (const [key, id] of ctx.toolRows) ctx.toolRows.set(key, replacements.get(id) ?? id);
  if (ctx.turn) {
    ctx.turn.headerRowId = replacements.get(ctx.turn.headerRowId) ?? ctx.turn.headerRowId;
    if (user && ctx.turn.turnId === oldTurn) {
      ctx.turn.turnId = turnId;
      ctx.turn.entityId = turnId;
    }
  }
  for (const [alias, entity] of aliases) source.aliases.set(alias, entity);
  const retained = new Set([...merged.values()].map((row) => row.entityId));
  for (const [alias, entity] of source.aliases)
    if (!retained.has(entity)) source.aliases.delete(alias);
  source.nextPosition += 1;
  source.leafId = entry.id;
  source.turn = turn;
  return [...merged.values()].sort((a, b) => a.rowId - b.rowId);
}
