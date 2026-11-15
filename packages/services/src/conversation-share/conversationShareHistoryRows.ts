import { CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import type {
  ConversationHistoryTurn,
  ConversationHistoryWatermark,
  ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationShareHistoryError } from "./conversationShareHistoryPolicy.js";

export interface ConversationShareRowsRead {
  rows: ConversationRow[];
  revision: number;
  logEpoch: string;
  turnOrdinals: Map<string, number>;
}

function invalid(): never {
  throw new ConversationShareHistoryError("history_invalid_page");
}

/** Request-local bounded identities, not an accepted projection/cache or renderer store. */
export class ShareHistoryRows {
  private readonly rows = new Map<number, ConversationRow>();
  private readonly entities = new Map<string, number>();
  private readonly turns = new Map<string, ConversationHistoryTurn>();
  private watermark?: ConversationHistoryWatermark;

  fence(value: ConversationHistoryWatermark): void {
    if (
      !value ||
      !Number.isSafeInteger(value.atSeq) ||
      value.atSeq < 0 ||
      !Number.isSafeInteger(value.atRevision) ||
      value.atRevision < 0 ||
      typeof value.atLogEpoch !== "string" ||
      !value.atLogEpoch
    )
      invalid();
    if (
      this.watermark &&
      (value.atSeq !== this.watermark.atSeq ||
        value.atRevision !== this.watermark.atRevision ||
        value.atLogEpoch !== this.watermark.atLogEpoch)
    )
      throw new ConversationShareHistoryError("history_stale");
    this.watermark = {
      atSeq: value.atSeq,
      atRevision: value.atRevision,
      atLogEpoch: value.atLogEpoch,
    };
  }

  turn(turn: ConversationHistoryTurn, repeated = false): void {
    if (
      !turn ||
      typeof turn.turnId !== "string" ||
      !turn.turnId ||
      !Number.isSafeInteger(turn.position) ||
      turn.position < 0 ||
      (turn.userEntryId !== null && typeof turn.userEntryId !== "string")
    )
      invalid();
    const previous = this.turns.get(turn.turnId);
    if (
      previous &&
      (!repeated ||
        previous.position !== turn.position ||
        previous.userEntryId !== turn.userEntryId)
    )
      invalid();
    if (!previous && this.turns.size >= CONVERSATION_ARCHIVE_LIMITS.rows)
      throw new ConversationShareHistoryError("history_budget_exceeded");
    this.turns.set(turn.turnId, turn);
  }

  /** Repeated owning headers and updated tool entities merge by identity, never concatenate. */
  add(rows: ConversationRow[], owners: ReadonlySet<string>): number {
    if (!Array.isArray(rows)) invalid();
    if (rows.length > CONVERSATION_ARCHIVE_LIMITS.rows)
      throw new ConversationShareHistoryError("history_budget_exceeded");
    let changedBodyRows = 0;
    let previousRowId = -1;
    for (const row of rows) {
      if (
        !row ||
        !Number.isSafeInteger(row.rowId) ||
        row.rowId < 1 ||
        row.rowId <= previousRowId ||
        typeof row.entityId !== "string" ||
        !row.entityId ||
        !owners.has(row.turnId) ||
        typeof row.productTurnId !== "string" ||
        !row.productTurnId
      )
        invalid();
      previousRowId = row.rowId;
      const previous = this.rows.get(row.rowId);
      const entityRowId = this.entities.get(row.entityId);
      if (entityRowId !== undefined && entityRowId !== row.rowId) invalid();
      if (
        previous &&
        (previous.entityId !== row.entityId ||
          previous.turnId !== row.turnId ||
          previous.productTurnId !== row.productTurnId ||
          previous.kind !== row.kind)
      )
        invalid();
      if (!previous && this.rows.size >= CONVERSATION_ARCHIVE_LIMITS.rows)
        throw new ConversationShareHistoryError("history_budget_exceeded");
      if (
        row.kind !== "turnHeader" &&
        (!previous || JSON.stringify(previous) !== JSON.stringify(row))
      )
        changedBodyRows++;
      this.rows.set(row.rowId, row);
      this.entities.set(row.entityId, row.rowId);
    }
    return changedBodyRows;
  }

  finish(): ConversationShareRowsRead {
    if (!this.watermark) invalid();
    const rows = [...this.rows.values()].sort((a, b) => a.rowId - b.rowId);
    const turnOrdinals = new Map<string, number>();
    const productByTurn = new Map<string, string>();
    let lastPosition = -1;
    for (const row of rows) {
      if (row.kind !== "turnHeader") continue;
      const turn = this.turns.get(row.turnId);
      if (
        !turn ||
        !row.productTurnId ||
        turn.position <= lastPosition ||
        productByTurn.has(row.turnId) ||
        turnOrdinals.has(row.productTurnId)
      )
        invalid();
      lastPosition = turn.position;
      productByTurn.set(row.turnId, row.productTurnId);
      turnOrdinals.set(row.productTurnId, turn.position + 1);
    }
    if (
      productByTurn.size !== this.turns.size ||
      rows.some((row) => row.productTurnId !== productByTurn.get(row.turnId))
    )
      invalid();
    const userTurns = new Set(
      rows.filter((row) => row.kind === "userInput").map((row) => row.turnId),
    );
    for (const turn of this.turns.values())
      if (turn.userEntryId !== null && !userTurns.has(turn.turnId)) invalid();
    return {
      rows,
      revision: this.watermark.atRevision,
      logEpoch: this.watermark.atLogEpoch,
      turnOrdinals,
    };
  }
}
