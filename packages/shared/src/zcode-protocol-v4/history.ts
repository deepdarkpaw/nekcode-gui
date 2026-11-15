/** Complete-turn source-history contracts. Cursors are private, session-bound capabilities. */
import { z } from "zod";
import type { ConversationSnapshot } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";

export const conversationHistoryTurnSchema = z.object({
  turnId: z.string(),
  userEntryId: z.string().nullable(),
  position: z.number().int().nonnegative(),
  preview: z.string().max(256),
});
export type ConversationHistoryTurn = z.infer<typeof conversationHistoryTurnSchema>;
export const conversationHistorySchema = z.object({
  branchRevision: z.string(),
  observationCursor: z.string().optional(),
  totalTurns: z.number().int().nonnegative(),
  /** A source page contains at most 20 complete turns; a renderer window may retain six 20-turn pages. */
  turns: z.array(conversationHistoryTurnSchema).max(120),
  olderCursor: z.string().optional(),
  newerCursor: z.string().optional(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
});
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;
/** Raw bounded transport excerpt, never a fabricated semantic answer/result. */
export const liveHistoryPreviewSchema = z.object({
  epoch: z.string(),
  eventId: z.number().int(),
  eventType: z.string(),
  preview: z.string().max(32768),
  receivedBytes: z.number().int().nonnegative(),
  incomplete: z.literal(true),
});
export type LiveHistoryPreview = z.infer<typeof liveHistoryPreviewSchema>;
/** Public share/export removes transient live tool extras. */
export function stripPrivateHistoryRow(row: ConversationRow): ConversationRow {
  if (row.kind === "toolCall") {
    const { liveResult: _transientExtras, ...storedRow } = row;
    return storedRow;
  }
  return row;
}

/** History-specific sanitizer; normal public-export sanitizers must still handle other private fields. */
export function stripPrivateHistorySnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  const {
    history: _historyCapabilities,
    liveHistoryPreview: _rawPreview,
    ...publicSnapshot
  } = snapshot;
  return {
    ...publicSnapshot,
    rows: { ...snapshot.rows, window: snapshot.rows.window.map(stripPrivateHistoryRow) },
  };
}

export interface ConversationHistoryWatermark {
  atSeq: number;
  atRevision: number;
  atLogEpoch: string;
}
/** Source observation is distinct from the host live watermark. Optional for bounded fixtures. */
export interface ConversationHistoryObservation {
  branchRevision?: string;
  observationCursor?: string;
}
export interface ConversationHistoryReadOptions {
  observationCursor?: string;
}
export interface ConversationHistoryPageOptions extends ConversationHistoryReadOptions {
  beforeCursor?: string;
  afterCursor?: string;
  aroundEntryId?: string;
  turnLimit?: number;
}
export interface ConversationHistoryDirectoryOptions extends ConversationHistoryReadOptions {
  query?: string;
  cursor?: string;
  direction?: "oldest" | "newest";
  aroundEntryId?: string;
  limit?: number;
}
export interface V4ConversationHistoryPageResult
  extends ConversationHistoryWatermark, ConversationHistoryObservation {
  rows: ConversationRow[];
  history: ConversationHistory;
}
export interface V4ConversationHistoryDirectoryResult
  extends ConversationHistoryWatermark, ConversationHistoryObservation {
  items: { entryId: string; turnId: string; position: number; preview: string }[];
  hasMore: boolean;
  nextCursor?: string;
  totalTurns: number;
}
