import type { ConversationHistoryObservation, ConversationHistoryReadOptions } from "./history.js";

/** The accepted owner supplies the guard; callers cannot smuggle a token into a deliberate reset. */
export function withHistoryObservation<T extends object>(
  options: T,
  observationCursor?: string,
): Omit<T, "observationCursor"> & ConversationHistoryReadOptions {
  const result: T & ConversationHistoryReadOptions = { ...options };
  delete result.observationCursor;
  if (observationCursor !== undefined) result.observationCursor = observationCursor;
  return result;
}

/** Call only after the trusted guarded source read succeeds; a response token alone is not proof. */
export function assertHistoryObservation(
  previous: ConversationHistoryObservation,
  next: ConversationHistoryObservation,
  supplied: string | undefined,
): void {
  if (previous.observationCursor !== undefined && supplied !== previous.observationCursor)
    throw new Error("History observation guard is missing; retry the scoped read");
  if (supplied && !next.observationCursor)
    throw new Error("History response omitted its observation proof; retry the scoped read");
  if (
    next.branchRevision !== undefined &&
    next.branchRevision !== previous.branchRevision &&
    (!supplied || !next.observationCursor)
  )
    throw new Error("History branch changed without observation proof; load latest explicitly");
}
