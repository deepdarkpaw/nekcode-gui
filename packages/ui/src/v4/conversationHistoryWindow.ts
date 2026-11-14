import type {
  ConversationDelta,
  ConversationHistory,
  ConversationRow,
  ConversationSnapshot,
  V4ConversationHistoryPageResult,
  V4ConversationHistoryTurnResult,
} from "@zcode/shared/zcode-protocol-v4";

/** Six host pages, never a full conversation cache. */
export const HISTORY_WINDOW_LIMITS = { pages: 6, turns: 120, bytes: 16 * 1024 * 1024 } as const;
export const HISTORY_BOUNDARY_REFRESH_REQUIRED =
  "Live history exceeded its cursor boundary; loadLatest or loadAround explicitly to refresh navigation";
export type HistoryDirection = "older" | "newer" | "around" | "latest" | "turn";
export interface HistoryOmission {
  turnId: string;
  reason: "budget";
}
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
  for (const row of current)
    if (!replace || historyRowWasChanged(row, changed)) rows.set(historyRowKey(row), row);
  for (const row of fetched) {
    const key = historyRowKey(row);
    if (!historyRowWasChanged(row, changed)) rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.rowId - b.rowId);
}

/** Bookkeeping only: body facts remain exclusively in the store snapshot. */
export class ConversationHistoryWindow {
  private pages: PageBoundary[] = [];
  private retentionDirection: HistoryDirection = "latest";
  private readingTurnId: string | undefined;
  private readonly sizes = new WeakMap<ConversationRow, number>();
  omissions: HistoryOmission[] = [];
  /** Live events have no new opaque page boundaries; explicit latest/around renews them. */
  needsBoundaryRefresh = false;

  reset(snapshot: ConversationSnapshot): ConversationSnapshot {
    this.pages = snapshot.history ? [this.boundary(snapshot.history)] : [];
    this.omissions = [];
    this.needsBoundaryRefresh = false;
    this.retentionDirection = "latest";
    this.readingTurnId = undefined;
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
    for (const delta of deltas) {
      if (delta.op === "row.delta")
        appends.set(
          delta.rowId,
          (appends.get(delta.rowId) ?? 0) + utf8.encode(delta.append).byteLength,
        );
      if (delta.op === "row.upserted" || delta.op === "row.appended") replaced.add(delta.row.rowId);
    }
    const previous = new Map(before.rows.window.map((row) => [row.rowId, row]));
    for (const row of after.rows.window) {
      const old = previous.get(row.rowId);
      if (old && row !== old && !replaced.has(row.rowId) && appends.has(row.rowId)) {
        this.sizes.set(row, this.size(old) + appends.get(row.rowId)!);
      }
    }
  }

  mergePage(
    current: ConversationSnapshot,
    result: V4ConversationHistoryPageResult,
    direction: HistoryDirection,
    changed: ReadonlySet<string>,
  ): ConversationSnapshot {
    const replace = direction === "around" || direction === "latest";
    if (replace) this.needsBoundaryRefresh = false;
    const incoming = this.boundary(result.history);
    this.retentionDirection = direction;
    this.readingTurnId = direction === "latest" ? undefined : incoming.turnIds[0];
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
    this.pages = pages;
    this.omissions = this.omissions.filter((item) => !ids.has(item.turnId) && !replace);
    return this.bound(
      {
        ...current,
        rows: { ...current.rows, window: rows, totalCount: rows.length },
        history: {
          ...result.history,
          turns: [...turns.values()].sort((a, b) => a.position - b.position),
        },
      },
      direction,
    );
  }

  mergeTurn(
    current: ConversationSnapshot,
    result: V4ConversationHistoryTurnResult,
    changed: ReadonlySet<string>,
    restart = false,
  ): ConversationSnapshot {
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
  bound(
    snapshot: ConversationSnapshot,
    direction: HistoryDirection = this.retentionDirection,
    requestedTurnId: string | undefined = this.readingTurnId,
  ): ConversationSnapshot {
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
      const removeIds = new Set(page.turnIds.filter((id) => !keepIds.has(id)));
      rows = rows.filter((row) => !removeIds.has(row.turnId));
      turns = turns.filter((turn) => !removeIds.has(turn.turnId));
      bytes = rows.reduce((total, row) => total + this.size(row), 0);
    }
    const liveTurns = [...new Set(rows.map((row) => row.turnId))];
    if (liveTurns.length > HISTORY_WINDOW_LIMITS.turns) {
      const drop = new Set(
        liveTurns
          .filter((id) => id !== requestedTurnId)
          .slice(0, liveTurns.length - HISTORY_WINDOW_LIMITS.turns),
      );
      rows = rows.filter((row) => !drop.has(row.turnId));
      turns = turns.filter((turn) => !drop.has(turn.turnId));
      bytes = rows.reduce((total, row) => total + this.size(row), 0);
      this.needsBoundaryRefresh = true;
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
        rows = rows.filter((row) => row.turnId !== turnId);
        turns = turns.filter((turn) => turn.turnId !== turnId);
        bytes = rows.reduce((total, row) => total + this.size(row), 0);
        this.needsBoundaryRefresh = true;
      }
    }
    const first = this.pages[0];
    const last = this.pages.at(-1);
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
        ...(first
          ? {
              olderCursor: first.olderCursor,
              hasOlder: this.needsBoundaryRefresh || first.hasOlder,
            }
          : {}),
        ...(last ? { newerCursor: last.newerCursor, hasNewer: last.hasNewer } : {}),
      },
    };
  }
}
