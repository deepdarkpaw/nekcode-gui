/** Sparse source identities reserve the final slots for deferred content and child/error markers. */
export const HISTORY_ROW_STRIDE = 1_048_576;
export function historyRowId(position: number, slot: number): number {
  const id = position * HISTORY_ROW_STRIDE + slot + 1;
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot >= HISTORY_ROW_STRIDE ||
    !Number.isSafeInteger(id)
  )
    throw new Error("nek history numeric row identity overflow");
  return id;
}
