import type { NekGuiInfo, NekHistoryResult } from "@zcode/shared/nek-protocol";
import { isNekSessionLockHolder } from "./types.js";

export const HISTORY_RPC_MAX_BYTES = 1024 * 1024;
/**
 * Source budget of one page of up to 20 complete turns. Measured on real 40-74 MB sessions,
 * projected rows are about 0.7-1.0x of the source page; text-only turns reach ~1.0x.
 */
export const HISTORY_PAGE_MAX_BYTES = 12 * 1024 * 1024;
/** Read just a committed entry and its owning header, not its entire turn. */
export function historyTargetQuery(aroundEntryId: string) {
  return {
    type: "read_history_page",
    view: "target",
    turnLimit: 1,
    aroundEntryId,
    maxBytes: HISTORY_PAGE_MAX_BYTES,
  } as const;
}
/** Projected page bound, below the 16 MB host window that also receives the initial page. */
export const HISTORY_RENDER_MAX_BYTES = 15 * 1024 * 1024;
export function requireHistoryPages(info: Pick<NekGuiInfo, "capabilities">): void {
  if (info.capabilities?.historyPages !== 2)
    throw new Error(
      "nek historyPages=2 (complete-turn history) is required; update nek on the execution target (including Remote SSH)",
    );
}
export class NekHistoryReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NekHistoryReadError";
  }
}
export function historyResult<T>(result: NekHistoryResult<T>): T {
  if (!result || typeof result.ok !== "boolean")
    throw new NekHistoryReadError("INVALID_RESPONSE", "nek returned an invalid history response");
  if (!result.ok) throw new NekHistoryReadError(result.error.code, result.error.message);
  if (
    "lockedBy" in result &&
    result.lockedBy !== undefined &&
    !isNekSessionLockHolder(result.lockedBy)
  )
    throw new NekHistoryReadError("INVALID_RESPONSE", "nek returned invalid history lock metadata");
  if (
    !("observationCursor" in result) ||
    typeof result.observationCursor !== "string" ||
    !result.observationCursor
  )
    throw new NekHistoryReadError(
      "INVALID_RESPONSE",
      "nek history response omitted observationCursor",
    );
  return result;
}
export function historyResultBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}
/** Measure the actual encoded public result; an over-budget single turn fails visibly. */
export function boundHistoryResult<T>(result: T, bytes = historyResultBytes(result)): T {
  if (bytes > HISTORY_RENDER_MAX_BYTES)
    throw new NekHistoryReadError(
      "RESPONSE_LIMIT",
      "nek history projection exceeds 15 MB even for one complete turn",
    );
  return result;
}
/** A multi-turn page that projects beyond the host window; reread with `nextTurnLimit` whole turns. */
export class NekHistoryPageTooLargeError extends NekHistoryReadError {
  constructor(
    readonly turns: number,
    readonly nextTurnLimit: number,
  ) {
    super(
      "RESPONSE_LIMIT",
      `nek history page of ${turns} turns exceeds the projected window; reading ${nextTurnLimit} turns`,
    );
    this.name = "NekHistoryPageTooLargeError";
  }
}
/**
 * Projected rows can outgrow their source page (tool arguments keep both object and text).
 * The next read asks for proportionally fewer whole turns; it never cuts a turn.
 */
export function smallerHistoryTurnLimit(turns: number, projectedBytes: number): number {
  return Math.max(
    1,
    Math.min(turns - 1, Math.floor((turns * HISTORY_RENDER_MAX_BYTES) / projectedBytes)),
  );
}
