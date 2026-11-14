import type { NekGuiInfo, NekHistoryResult } from "@zcode/shared/nek-protocol";

export const HISTORY_RPC_MAX_BYTES = 1024 * 1024;
export const HISTORY_RENDER_MAX_BYTES = 4 * 1024 * 1024;
export function requireHistoryPages(info: Pick<NekGuiInfo, "capabilities">): void {
  if (info.capabilities?.historyPages !== 1)
    throw new Error(
      "nek historyPages=1 is required; update nek on the execution target (including Remote SSH)",
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
/** Measure actual encoded public result, allowing envelope headroom below the 16 MB transport cap. */
export function boundHistoryResult<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > HISTORY_RENDER_MAX_BYTES)
    throw new NekHistoryReadError(
      "RESPONSE_LIMIT",
      "nek history projection exceeds 4 MB; request a smaller source page",
    );
  return result;
}
