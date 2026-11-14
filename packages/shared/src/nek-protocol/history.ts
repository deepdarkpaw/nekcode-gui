/** Mirror of nek gui/history-protocol.ts. Display projections NEVER replace model/storage entries. */
import type { NekStatusSnapshot } from "./status.js";
import type { NekSessionLockHolder, NekSessionSummary } from "./gui-rpc.js";

/** The CLI currently exposes a total count, not an enumerable persisted child directory. */
export interface NekHistoryStatusSnapshot extends NekStatusSnapshot {
  /** Persisted total and known persisted IDs in the bounded view; completeness is conservative. */
  historyChildren?: { total: number; loaded: number; complete: boolean };
}

export interface NekHistoryOptions {
  sessionPath?: string;
  branchRevision?: string;
  /** Full UTF8 RPC envelope: default 1 MB, range 64 KB..4 MB. */
  maxBytes?: number;
}
export type NekHistoryCommand =
  | ({ id?: string; type: "read_session_metadata" } & NekHistoryOptions)
  | ({
      id?: string;
      type: "read_history_page";
      beforeCursor?: string;
      afterCursor?: string;
      aroundEntryId?: string;
      turnLimit?: number;
    } & NekHistoryOptions)
  | ({
      id?: string;
      type: "read_history_turn";
      turnId: string;
      cursor?: string;
    } & NekHistoryOptions)
  | ({
      id?: string;
      type: "read_history_directory";
      query?: string;
      cursor?: string;
      direction?: "oldest" | "newest";
      aroundEntryId?: string;
      limit?: number;
    } & NekHistoryOptions)
  | ({
      id?: string;
      type: "read_history_content";
      ref: string;
      offset?: number;
      limit?: number;
    } & NekHistoryOptions)
  | ({ id?: string; type: "read_history_subagent"; subagentId: string } & NekHistoryOptions);
export type NekHistoryErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_CURSOR"
  | "STALE_CURSOR"
  | "FOREIGN_CURSOR"
  | "NOT_FOUND"
  | "INDEX_LIMIT"
  | "INVALID_STORAGE"
  | "RESPONSE_LIMIT";
export type NekHistoryResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: { code: NekHistoryErrorCode; message: string } };
export interface NekHistoryIdentity {
  sessionPath: string;
  sessionId: string;
  branchRevision: string;
  leafId: string | null;
  /** Persisted storage watermark, NOT the host live seq. */
  watermark: { entryId: number; conversationId: number; nextSeq: number };
}
export interface NekHistorySelection {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}
export interface NekHistoryOmission {
  pointer: string;
  ref: string;
  totalBytes: number;
  mediaType: "application/json";
  encoding: "base64";
}
export interface NekHistoryEntry {
  id: string;
  parentId: string | null;
  position: number;
  turnId: string;
  timestamp: string;
  type: string;
  role?: string;
  preview: string;
  entry: Record<string, unknown>;
  omissions: NekHistoryOmission[];
}
export interface NekHistoryTurn {
  id: string;
  userEntryId: string | null;
  position: number;
  preview: string;
  entryCount: number;
  header: NekHistoryEntry;
  continuationCursor?: string;
}
export interface NekHistoryMetadata extends NekHistoryIdentity {
  session: NekSessionSummary;
  lockedBy?: NekSessionLockHolder;
  totalTurns: number;
  totalEntries: number;
  selection: NekHistorySelection;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
  children: { count: number };
  status: "persisted";
}
export interface NekHistoryPage extends NekHistoryIdentity {
  turns: NekHistoryTurn[];
  entries: NekHistoryEntry[];
  olderCursor?: string;
  newerCursor?: string;
  hasOlder: boolean;
  hasNewer: boolean;
  totalTurns: number;
  totalEntries: number;
  seed: NekHistorySelection;
}
export interface NekHistoryTurnPage extends NekHistoryIdentity {
  turn: NekHistoryTurn;
  entries: NekHistoryEntry[];
  hasMore: boolean;
  continuationCursor?: string;
}
export interface NekHistoryDirectory extends NekHistoryIdentity {
  items: { entryId: string; turnId: string; position: number; preview: string }[];
  hasMore: boolean;
  nextCursor?: string;
  totalTurns: number;
}
export interface NekHistoryContent extends NekHistoryIdentity {
  ref: string;
  offset: number;
  totalBytes: number;
  mediaType: "application/json";
  encoding: "base64";
  data: string;
  nextOffset?: number;
}
export interface NekHistorySubagentRecord {
  id: string;
  spawnEntryId: string;
  spawnPosition: number;
  sessionFile?: string;
  type?: string;
  description?: string;
  status?: string;
  model?: string;
  startedAt?: number;
  endedAt?: number;
  detached: true;
}
export interface NekHistorySubagent extends NekHistoryIdentity {
  subagent: NekHistorySubagentRecord;
}
export interface NekHistoryResponseData {
  read_session_metadata: NekHistoryResult<NekHistoryMetadata>;
  read_history_page: NekHistoryResult<NekHistoryPage>;
  read_history_turn: NekHistoryResult<NekHistoryTurnPage>;
  read_history_directory: NekHistoryResult<NekHistoryDirectory>;
  read_history_content: NekHistoryResult<NekHistoryContent>;
  read_history_subagent: NekHistoryResult<NekHistorySubagent>;
}
