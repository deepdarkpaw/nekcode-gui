import type {
  ConversationDelta,
  ConversationHistory,
  ConversationHistoryPageOptions,
  ConversationRow,
  ConversationSnapshot,
  V4ConversationHistoryPageResult,
  V4ConversationHistoryTurnResult,
} from "@zcode/shared/zcode-protocol-v4";

import {
  historyEdges,
  historyAppendJsonBytes,
  historyStreamTail,
  mergeLoadedHistoryBoundary,
  type HistoryViewportAnchor,
} from "./conversationHistoryBoundary.js";

/** Six host pages, never a full conversation cache. */
export const HISTORY_WINDOW_LIMITS = { pages: 6, turns: 120, bytes: 16 * 1024 * 1024 } as const;
export const HISTORY_BOUNDARY_REFRESH_REQUIRED =
  "Live history exceeded its cursor boundary; loadLatest or loadAround explicitly to refresh navigation";
export type HistoryDirection = "older" | "newer" | "around" | "latest" | "turn";
export interface HistoryOmission {
  turnId: string;
  reason: "budget";
}
/** A child transcript has the same body/history window, without parent control/config facts. */
type HistoryWindowBody = Pick<ConversationSnapshot, "rows" | "history">;
interface PageBoundary extends Omit<ConversationHistory, "turns"> {
  turnIds: string[];
}
export const historyRowKey = (row: ConversationRow): string => row.entityId ?? `row:${row.rowId}`;
export const historyRowWasChanged = (row: ConversationRow, changed: ReadonlySet<string>): boolean =>
  changed.has(historyRowKey(row)) || changed.has(`row:${row.rowId}`);
const utf8 = new TextEncoder();

/** Stable identity merge; an overlapping read cannot replace a row changed since admission. */
export function mergeHistoryRows(
  current: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
  changed: ReadonlySet<string>,
  replace: boolean,
): ConversationRow[] {
  const rows = new Map<string, ConversationRow>();
  const ids = new Map<number, string>();
  const put = (row: ConversationRow) => {
    const key = historyRowKey(row);
    const oldKey = ids.get(row.rowId);
    if (oldKey) rows.delete(oldKey);
    const old = rows.get(key);
    if (old) ids.delete(old.rowId);
    rows.set(key, row);
    ids.set(row.rowId, key);
  };
  for (const row of current) if (!replace || historyRowWasChanged(row, changed)) put(row);
  for (const row of fetched) if (!historyRowWasChanged(row, changed)) put(row);
  return [...rows.values()].sort((a, b) => a.rowId - b.rowId);
}

/** Bookkeeping only: body facts remain exclusively in the store snapshot. */
export class ConversationHistoryWindow {
  private pages: PageBoundary[] = [];
  private retentionDirection: HistoryDirection = "latest";
  private readingTurnId: string | undefined;
  private viewportPinned = false;
  private unprovenCut = false;
  private latestBoundary:
    | { history: ConversationHistory; seq: number; revision: number }
    | undefined;

  setViewportAnchor(anchor: HistoryViewportAnchor): boolean {
    const turnId = anchor.followingLatest ? undefined : anchor.turnId;
    if (this.viewportPinned === !anchor.followingLatest && this.readingTurnId === turnId)
      return false;
    this.viewportPinned = !anchor.followingLatest;
    this.readingTurnId = turnId;
    this.retentionDirection = anchor.followingLatest ? "latest" : "around";
    return true;
  }

  /** Only ordered same-owner host patches call this; a summary is never a loaded body page. */
  observeBoundary<T extends HistoryWindowBody>(
    snapshot: T,
    boundary: ConversationHistory,
    seq: number,
    revision: number,
  ): T {
    this.latestBoundary = {
      history: { ...boundary, turns: boundary.turns.slice(-20) },
      seq,
      revision,
    };
    if (!snapshot.history) return snapshot;
    return {
      ...snapshot,
      history: mergeLoadedHistoryBoundary(
        snapshot.history,
        snapshot.rows.window,
        this.latestBoundary.history,
      ),
    };
  }

  navigationEdge(snapshot: HistoryWindowBody, direction: "older" | "newer") {
    return snapshot.history
      ? historyEdges(snapshot.history, snapshot.rows.window, this.readingTurnId)[direction]
      : undefined;
  }

  /** An explicit user read repairs a cut boundary with one bounded source around slice. */
  pageOptions(
    snapshot: HistoryWindowBody,
    direction: "older" | "newer",
  ): ConversationHistoryPageOptions {
    const cursor =
      direction === "older" ? snapshot.history?.olderCursor : snapshot.history?.newerCursor;
    if (cursor) return direction === "older" ? { beforeCursor: cursor } : { afterCursor: cursor };
    const edge = this.navigationEdge(snapshot, direction);
    if (edge?.userEntryId) return { aroundEntryId: edge.userEntryId };
    throw new Error(HISTORY_BOUNDARY_REFRESH_REQUIRED);
  }
  /** A true branch truncation retires capabilities; ordinary append metadata does not. */
  invalidateSourceBoundaries(): void {
    this.pages = [];
    this.latestBoundary = undefined;
    this.needsBoundaryRefresh = true;
  }

  private readonly sizes = new WeakMap<ConversationRow, number>();
  omissions: HistoryOmission[] = [];
  /** Missing source proof remains visible; ordered metadata or explicit bounded reads can renew it. */
  needsBoundaryRefresh = false;

  reset<T extends HistoryWindowBody>(snapshot: T): T {
    this.pages = snapshot.history ? [this.boundary(snapshot.history)] : [];
    this.latestBoundary = undefined;
    this.unprovenCut = false;
    this.omissions = [];
    this.needsBoundaryRefresh = false;
    this.retentionDirection = "latest";
    this.readingTurnId = undefined;
    this.viewportPinned = false;
    return snapshot.history ? this.bound(snapshot, "latest") : snapshot;
  }

  private boundary(history: ConversationHistory): PageBoundary {
    const { turns, ...rest } = history;
    return { ...rest, turnIds: turns.map((turn) => turn.turnId) };
  }

  private size(row: ConversationRow): number {
    let bytes = this.sizes.get(row);
    if (bytes === undefined) {
      bytes = utf8.encode(JSON.stringify(row)).byteLength;
      this.sizes.set(row, bytes);
    }
    return bytes;
  }

  /** Token deltas account only for appended bytes, never serialize a full snapshot per token. */
  accountDeltas(
    before: ConversationSnapshot,
    after: ConversationSnapshot,
    deltas: readonly ConversationDelta[],
  ): void {
    const appends = new Map<number, number>();
    const replaced = new Set<number>();
    const previous = new Map(before.rows.window.map((row) => [row.rowId, row]));
    const tails = new Map<string, string>();
    for (const delta of deltas) {
      if (delta.op === "row.delta") {
        const key = `${delta.rowId}:${delta.path}`;
        const tail = tails.get(key) ?? historyStreamTail(previous.get(delta.rowId), delta.path);
        appends.set(
          delta.rowId,
          (appends.get(delta.rowId) ?? 0) + historyAppendJsonBytes(delta.append, tail),
        );
        if (delta.append) tails.set(key, delta.append.slice(-1));
      }
      if (delta.op === "row.upserted" || delta.op === "row.appended") replaced.add(delta.row.rowId);
    }
    for (const row of after.rows.window) {
      const old = previous.get(row.rowId);
      if (old && row !== old && !replaced.has(row.rowId) && appends.has(row.rowId)) {
        this.sizes.set(row, this.size(old) + appends.get(row.rowId)!);
      }
    }
  }

  mergePage<T extends HistoryWindowBody>(
    current: T,
    result: V4ConversationHistoryPageResult,
    direction: HistoryDirection,
    changed: ReadonlySet<string>,
  ): T {
    const replace = direction === "around" || direction === "latest";
    if (replace) {
      this.needsBoundaryRefresh = false;
      this.unprovenCut = false;
    }
    const incoming = this.boundary(result.history);
    this.retentionDirection = direction;
    if (replace) this.viewportPinned = false;
    this.readingTurnId =
      direction === "latest"
        ? undefined
        : this.viewportPinned
          ? this.readingTurnId
          : incoming.turnIds[0];
    const ids = new Set(incoming.turnIds);
    // Keep overlapping page membership intact: trimming it would invalidate that page's
    // opaque boundary cursor when its neighbor is later evicted.
    const previous = this.pages.filter(
      (page) =>
        page.turnIds.length !== incoming.turnIds.length ||
        page.turnIds.some((id, index) => id !== incoming.turnIds[index]),
    );
    const pages = replace
      ? [incoming]
      : direction === "older"
        ? [incoming, ...previous]
        : [...previous, incoming];
    const turns = new Map(
      (replace ? [] : (current.history?.turns ?? [])).map((turn) => [turn.turnId, turn]),
    );
    for (const turn of result.history.turns) turns.set(turn.turnId, turn);
    const rows = mergeHistoryRows(current.rows.window, result.rows, changed, replace);
    const positions = new Map([...turns.values()].map((turn) => [turn.turnId, turn.position]));
    this.pages = pages.sort(
      (a, b) =>
        (positions.get(a.turnIds[0]!) ?? Infinity) - (positions.get(b.turnIds[0]!) ?? Infinity),
    );
    this.omissions = this.omissions.filter((item) => !ids.has(item.turnId) && !replace);
    const history = {
      ...result.history,
      turns: [...turns.values()].sort((a, b) => a.position - b.position),
    };
    const boundary = this.latestBoundary;
    const acceptedHistory =
      boundary && (result.atSeq < boundary.seq || result.atRevision < boundary.revision)
        ? mergeLoadedHistoryBoundary(history, rows, boundary.history)
        : history;
    return this.bound(
      {
        ...current,
        rows: { ...current.rows, window: rows, totalCount: rows.length },
        history: acceptedHistory,
      },
      direction,
    );
  }

  mergeTurn<T extends HistoryWindowBody>(
    current: T,
    result: V4ConversationHistoryTurnResult,
    changed: ReadonlySet<string>,
    restart = false,
  ): T {
    if (!current.history) return current;
    const base = restart
      ? current.rows.window.filter(
          (row) => row.turnId !== result.turn.turnId || historyRowWasChanged(row, changed),
        )
      : current.rows.window;
    let rows = mergeHistoryRows(base, result.rows, changed, false);
    const turnBytes = rows
      .filter((row) => row.turnId === result.turn.turnId)
      .reduce((n, row) => n + this.size(row), 0);
    const droppedPreviousSlice = turnBytes > HISTORY_WINDOW_LIMITS.bytes;
    if (droppedPreviousSlice) {
      const keep = current.rows.window.filter(
        (row) =>
          row.turnId !== result.turn.turnId ||
          row.kind === "turnHeader" ||
          row.kind === "userInput",
      );
      rows = mergeHistoryRows(keep, result.rows, changed, false);
    }
    const turn = { ...result.turn, continuationCursor: result.continuationCursor };
    this.readingTurnId = turn.turnId;
    this.retentionDirection = "turn";
    const turns = current.history.turns.map((item) => (item.turnId === turn.turnId ? turn : item));
    if (restart) this.omissions = this.omissions.filter((item) => item.turnId !== turn.turnId);
    if (droppedPreviousSlice && !this.omissions.some((item) => item.turnId === turn.turnId))
      this.omissions.push({ turnId: turn.turnId, reason: "budget" });
    return this.bound(
      {
        ...current,
        rows: { ...current.rows, window: rows, totalCount: rows.length },
        history: { ...current.history, turns },
      },
      "turn",
      turn.turnId,
    );
  }

  /** Whole-page eviction retains the exact host capabilities of the surviving boundaries. */
  bound<T extends HistoryWindowBody>(
    snapshot: T,
    direction: HistoryDirection = this.retentionDirection,
    requestedTurnId: string | undefined = this.readingTurnId,
  ): T {
    if (!snapshot.history) return snapshot;
    let rows = snapshot.rows.window;
    let turns = snapshot.history.turns;
    let bytes = rows.reduce((total, row) => total + this.size(row), 0);
    const exceeds = () =>
      this.pages.length > HISTORY_WINDOW_LIMITS.pages ||
      new Set(rows.map((row) => row.turnId)).size > HISTORY_WINDOW_LIMITS.turns ||
      bytes > HISTORY_WINDOW_LIMITS.bytes;
    while (this.pages.length > 1 && exceeds()) {
      const retainFirst =
        direction === "older" ||
        (requestedTurnId !== undefined && this.pages[0]!.turnIds.includes(requestedTurnId));
      const page = retainFirst ? this.pages.pop()! : this.pages.shift()!;
      const keepIds = new Set(this.pages.flatMap((item) => item.turnIds));
      const removeIds = new Set(
        page.turnIds.filter((id) => !keepIds.has(id) && id !== requestedTurnId),
      );
      rows = rows.filter((row) => !removeIds.has(row.turnId));
      turns = turns.filter((turn) => !removeIds.has(turn.turnId));
      bytes = rows.reduce((total, row) => total + this.size(row), 0);
    }
    const liveTurns = [...new Set(rows.map((row) => row.turnId))];
    if (liveTurns.length > HISTORY_WINDOW_LIMITS.turns) {
      this.unprovenCut = true;
      const anchor = liveTurns.indexOf(requestedTurnId ?? "");
      const candidates = liveTurns
        .map((id, index) => ({ id, index }))
        .filter((item) => item.id !== requestedTurnId);
      if (anchor >= 0)
        candidates.sort((a, b) => Math.abs(b.index - anchor) - Math.abs(a.index - anchor));
      const drop = new Set(
        candidates.slice(0, liveTurns.length - HISTORY_WINDOW_LIMITS.turns).map((item) => item.id),
      );
      rows = rows.filter((row) => !drop.has(row.turnId));
      turns = turns.filter((turn) => !drop.has(turn.turnId));
      bytes = rows.reduce((total, row) => total + this.size(row), 0);
    }
    /** An oversized hydrated/live turn is explicitly omitted, not silently cut in half. */
    if (exceeds()) {
      const byTurn = new Map<string, ConversationRow[]>();
      for (const row of rows) {
        const list = byTurn.get(row.turnId) ?? [];
        list.push(row);
        byTurn.set(row.turnId, list);
      }
      const candidates = [...byTurn].sort(
        (a, b) =>
          Number(a[0] === requestedTurnId) - Number(b[0] === requestedTurnId) ||
          b[1].reduce((n, row) => n + this.size(row), 0) -
            a[1].reduce((n, row) => n + this.size(row), 0),
      );
      for (const [turnId, body] of candidates) {
        if (!exceeds()) break;
        const header = body.find((row) => row.kind === "turnHeader");
        rows = rows.filter((row) => row.turnId !== turnId || row === header);
        if (!this.omissions.some((item) => item.turnId === turnId))
          this.omissions.push({ turnId, reason: "budget" });
        bytes = rows.reduce((total, row) => total + this.size(row), 0);
      }
    }
    // A long uninterrupted live stream can outgrow every admitted host page. Bound it
    // strictly, but never fabricate a cursor for a boundary the host has not issued.
    if (exceeds()) {
      const ordered = [...new Set(rows.map((row) => row.turnId))];
      for (const turnId of ordered) {
        if (!exceeds()) break;
        if (turnId === requestedTurnId && ordered.length > 1) continue;
        this.unprovenCut = true;
        rows = rows.filter((row) => row.turnId !== turnId);
        turns = turns.filter((turn) => turn.turnId !== turnId);
        bytes = rows.reduce((total, row) => total + this.size(row), 0);
      }
    }
    const history = { ...snapshot.history, turns };
    const edges = historyEdges(history, rows, requestedTurnId);
    const boundaries = [
      ...this.pages,
      ...(this.latestBoundary ? [this.boundary(this.latestBoundary.history)] : []),
    ];
    const first = boundaries.find((page) => page.turnIds[0] === edges.older?.turnId);
    const last = boundaries.findLast((page) => page.turnIds.at(-1) === edges.newer?.turnId);
    const hasOlder = edges.older ? edges.older.position > 0 : this.unprovenCut || history.hasOlder;
    const hasNewer = edges.newer ? edges.newer.position + 1 < history.totalTurns : history.hasNewer;
    const olderCursor = hasOlder ? first?.olderCursor : undefined;
    const newerCursor = hasNewer ? last?.newerCursor : undefined;
    this.needsBoundaryRefresh =
      (hasOlder && !olderCursor && !edges.older?.userEntryId) ||
      (hasNewer && !newerCursor && !edges.newer?.userEntryId);
    const visible = new Set([
      ...rows.map((row) => row.turnId),
      ...turns.map((turn) => turn.turnId),
    ]);
    this.omissions = this.omissions
      .filter((item) => visible.has(item.turnId))
      .slice(-HISTORY_WINDOW_LIMITS.turns);
    return {
      ...snapshot,
      rows: { ...snapshot.rows, window: rows, totalCount: rows.length },
      history: {
        ...snapshot.history,
        turns,
        olderCursor,
        hasOlder,
        newerCursor,
        hasNewer,
      },
    };
  }
}
