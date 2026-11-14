import type {
  ConversationHistoryPageOptions,
  ConversationHistoryWatermark,
  V4ConversationHistoryPageResult,
  V4ConversationHistoryTurnResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationHistoryWindow } from "@/v4/conversationHistoryWindow.js";
import type { SubagentConversation } from "./useSubagentConversation.js";

export type ChildPageDirection = "older" | "newer" | "around" | "latest";
const bodyOf = (data: SubagentConversation) => ({
  history: data.history,
  rows: {
    window: data.rows,
    totalCount: data.rows.length,
    firstRowId: data.rows[0]?.rowId ?? null,
  },
});
export function assertChildWatermark(
  result: ConversationHistoryWatermark,
  captured?: ConversationHistoryWatermark,
): void {
  if (
    captured &&
    (result.atLogEpoch !== captured.atLogEpoch ||
      result.atSeq < captured.atSeq ||
      result.atRevision < captured.atRevision)
  )
    throw new Error("Child history watermark changed; load latest explicitly");
}
const watermarkOf = (result: ConversationHistoryWatermark): ConversationHistoryWatermark => ({
  atSeq: result.atSeq,
  atRevision: result.atRevision,
  atLogEpoch: result.atLogEpoch,
});

function assertChildPage(result: Pick<V4ConversationHistoryPageResult, "history" | "rows">): void {
  const history = result.history;
  if (
    !history ||
    history.turns.length > 20 ||
    (history.totalTurns > 0 && (!history.turns.length || !result.rows.length))
  )
    throw new Error("Child history returned an invalid bounded page");
  if ((history.hasOlder && !history.olderCursor) || (history.hasNewer && !history.newerCursor))
    throw new Error("Child history response omitted a cursor");
}

/** Child body's only accepted state. Deterministic transitions; no IO, timer, or duplicate cache. */
export class SubagentHistoryBody {
  data?: SubagentConversation;
  readonly window = new ConversationHistoryWindow();
  watermark?: ConversationHistoryWatermark;
  stale = false;
  readingLatest = true;
  latestDirty = false;
  directoryRevision = 0;

  private commit(body: ReturnType<typeof bodyOf>): void {
    this.data = {
      ...this.data!,
      rows: body.rows.window,
      history: body.history,
      totalCount: body.rows.window.length,
    };
  }
  get history() {
    return this.data
      ? { ...this.data.history, hasNewer: this.data.history.hasNewer || this.latestDirty }
      : undefined;
  }
  applyPreview(preview: SubagentConversation, fresh = false): void {
    assertChildPage(preview);
    if (!fresh && this.data && preview.history.branchRevision !== this.data.history.branchRevision)
      throw new Error("Child history branch changed; load latest explicitly");
    const changed = this.data?.history.totalTurns !== preview.history.totalTurns;
    if (!this.data || this.readingLatest || fresh) {
      this.data = { ...preview, totalCount: preview.rows.length };
      this.commit(this.window.reset(bodyOf(this.data)));
      if (fresh) {
        this.stale = false;
        this.watermark = undefined;
        this.readingLatest = true;
        this.latestDirty = false;
      }
    } else {
      this.data = {
        ...this.data,
        status: preview.status,
        history: { ...this.data.history, totalTurns: preview.history.totalTurns },
      };
      this.latestDirty = true;
    }
    if (changed) this.directoryRevision++;
  }
  pageOptions(
    direction: ChildPageDirection,
    options: ConversationHistoryPageOptions,
  ): ConversationHistoryPageOptions | null {
    const history = this.data!.history;
    if (
      (this.stale && direction !== "latest") ||
      (this.window.needsBoundaryRefresh && direction !== "latest" && direction !== "around")
    )
      throw new Error("Child history owner changed; load latest explicitly");
    if (
      (direction === "older" && !history.hasOlder) ||
      (direction === "newer" && !history.hasNewer && !this.latestDirty)
    )
      return null;
    if (direction === "older") {
      if (!history.olderCursor)
        throw new Error("Child history cursor is missing; load latest explicitly");
      return { beforeCursor: history.olderCursor };
    }
    if (direction === "newer") {
      if (history.newerCursor) return { afterCursor: history.newerCursor };
      // A live status poll has no new page capability. Explicit forward navigation may
      // resolve from the last authoritative entry without touching the older viewport first.
      const entryId = history.turns.at(-1)?.userEntryId;
      if (this.latestDirty && entryId) return { aroundEntryId: entryId };
      throw new Error("Child history cursor is missing; load latest explicitly");
    }
    return options;
  }
  applyPage(
    result: V4ConversationHistoryPageResult,
    direction: ChildPageDirection,
    options: ConversationHistoryPageOptions,
  ): void {
    const history = this.data!.history;
    if (direction === "latest" && !this.stale && this.watermark?.atLogEpoch === result.atLogEpoch)
      assertChildWatermark(result, this.watermark);
    if (direction !== "latest") {
      assertChildWatermark(result, this.watermark);
      if (result.history.branchRevision !== history.branchRevision)
        throw new Error("Child history branch changed; load latest explicitly");
    }
    assertChildPage(result);
    if (
      (direction === "older" &&
        result.history.hasOlder &&
        result.history.olderCursor === options.beforeCursor) ||
      (direction === "newer" &&
        options.afterCursor &&
        result.history.hasNewer &&
        result.history.newerCursor === options.afterCursor)
    )
      throw new Error("Child history cursor did not advance");
    const positions = history.turns.map((turn) => turn.position);
    if (
      (direction === "older" &&
        !result.history.turns.some((turn) => turn.position < Math.min(...positions))) ||
      (direction === "newer" &&
        options.afterCursor &&
        !result.history.turns.some((turn) => turn.position > Math.max(...positions)))
    )
      throw new Error("Child history page did not advance the reading window");
    this.commit(this.window.mergePage(bodyOf(this.data!), result, direction, new Set()));
    this.watermark = watermarkOf(result);
    this.stale = false;
    this.latestDirty = false;
    this.readingLatest =
      direction === "latest" || (direction === "newer" && !result.history.hasNewer);
  }
  applyTurn(result: V4ConversationHistoryTurnResult, turnId: string, cursor?: string): void {
    if (!this.data || this.stale)
      throw new Error("Child history is unavailable; load latest explicitly");
    assertChildWatermark(result, this.watermark);
    if (!this.data.history.turns.some((turn) => turn.turnId === turnId) || !result.rows.length)
      throw new Error("Child history turn is not loaded or omitted rows; load around explicitly");
    if (
      result.turn.turnId !== turnId ||
      (result.hasMore && (!result.continuationCursor || result.continuationCursor === cursor))
    )
      throw new Error("Child history turn identity/cursor did not advance");
    this.commit(this.window.mergeTurn(bodyOf(this.data), result, new Set(), cursor === undefined));
    this.watermark = watermarkOf(result);
    this.readingLatest = false;
  }
}
