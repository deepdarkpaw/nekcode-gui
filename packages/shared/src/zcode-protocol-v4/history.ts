/** Bounded source-history contracts. Cursors and refs are private, session-bound capabilities. */
import { z } from "zod";
import type { ConversationSnapshot } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";

export const historyContentReferenceSchema = z.object({
  ref: z.string(),
  pointer: z.string(),
  totalBytes: z.number().int().nonnegative(),
  mediaType: z.string(),
  encoding: z.literal("base64"),
  entryId: z.string().optional(),
  format: z.enum(["durable-record", "session-entry"]).optional(),
});
export type HistoryContentReference = z.infer<typeof historyContentReferenceSchema>;
export const conversationHistoryTurnSchema = z.object({
  turnId: z.string(),
  userEntryId: z.string().nullable(),
  position: z.number().int().nonnegative(),
  preview: z.string().max(256),
  continuationCursor: z.string().optional(),
});
export type ConversationHistoryTurn = z.infer<typeof conversationHistoryTurnSchema>;
export const conversationHistorySchema = z.object({
  branchRevision: z.string(),
  totalTurns: z.number().int().nonnegative(),
  /** A source page is at most20; a renderer window may retain six such pages. */
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
/** Public share/export must remove local read capabilities, even when deferred previews remain. */
export function stripPrivateHistoryRow(row: ConversationRow): ConversationRow {
  const { historyContent: _privateRefs, ...publicRow } = row;
  if (publicRow.kind === "toolCall") {
    const { liveResult: _transientExtras, ...storedRow } = publicRow;
    return storedRow;
  }
  return publicRow;
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
export interface ConversationHistoryPageOptions {
  beforeCursor?: string;
  afterCursor?: string;
  aroundEntryId?: string;
  turnLimit?: number;
}
export interface ConversationHistoryTurnOptions {
  turnId: string;
  cursor?: string;
}
export interface ConversationHistoryDirectoryOptions {
  query?: string;
  cursor?: string;
  direction?: "oldest" | "newest";
  aroundEntryId?: string;
  limit?: number;
}
export interface ConversationHistoryContentOptions {
  ref: string;
  offset?: number;
  limit?: number;
}
export interface V4ConversationHistoryPageResult extends ConversationHistoryWatermark {
  rows: ConversationRow[];
  history: ConversationHistory;
}
export interface V4ConversationHistoryTurnResult extends ConversationHistoryWatermark {
  rows: ConversationRow[];
  turn: ConversationHistoryTurn;
  hasMore: boolean;
  continuationCursor?: string;
}
export interface V4ConversationHistoryDirectoryResult extends ConversationHistoryWatermark {
  items: { entryId: string; turnId: string; position: number; preview: string }[];
  hasMore: boolean;
  nextCursor?: string;
  totalTurns: number;
}
export interface V4ConversationHistoryContentResult extends ConversationHistoryWatermark {
  ref: string;
  offset: number;
  totalBytes: number;
  mediaType: string;
  encoding: "base64";
  /** Raw UTF8 JSON bytes. Concatenate decoded bytes before JSON.parse. */
  data: string;
  nextOffset?: number;
}
