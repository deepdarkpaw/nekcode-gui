/** Mirror of nek gui/history-protocol.ts. Display projections NEVER replace model/storage entries. */
import type { NekStatusSnapshot } from "./status.js";
import type { NekSessionLockHolder, NekSessionSummary } from "./gui-rpc.js";

/** Persisted child metadata is a bounded directory, not a second live registry. */
export interface NekHistoryChildren {
  total: number;
  loaded: number;
  complete: boolean;
  items?: NekHistorySubagentRecord[];
  hasMore?: boolean;
  nextCursor?: string;
}
export type NekHistoryStatusSnapshot = NekStatusSnapshot;

export interface NekHistoryOptions {
  sessionPath?: string;
  branchRevision?: string;
  /** Signed prefix observation; compatible append is allowed, observed rewrites are rejected. */
  observationCursor?: string;
  /** Full UTF8 RPC envelope: default 1 MB, range 64 KB..32 MB (65536..33554432 bytes). */
  maxBytes?: number;
}
export type NekHistoryCommand =
  | ({ id?: string; type: "read_session_metadata" } & NekHistoryOptions)
  | ({
      id?: string;
      type: "read_history_page";
      view?: "entries" | "summary" | "target";
      beforeCursor?: string;
      afterCursor?: string;
      aroundEntryId?: string;
      turnLimit?: number;
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
  | NekHistorySubagentCommand;
export type NekHistorySubagentCommand =
  | ({
      id?: string;
      type: "read_history_subagent";
      subagentId: string;
      cursor?: never;
      limit?: never;
    } & NekHistoryOptions)
  | ({
      id?: string;
      type: "read_history_subagent";
      subagentId?: undefined;
      cursor?: string;
      limit?: number;
    } & NekHistoryOptions);
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
  observationCursor: string;
  leafId: string | null;
  /** Persisted storage watermark, NOT the host live seq. */
  watermark: { entryId: number; conversationId: number; nextSeq: number };
}
export interface NekHistorySelection {
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
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
  toolCallOrigin?: { entryId: string; position: number; toolCallId: string; name: string } | null;
  subagents?: NekHistorySubagentRecord[];
  subagentCount?: number;
  entry: Record<string, unknown>;
}
export interface NekHistoryTurn {
  id: string;
  userEntryId: string | null;
  position: number;
  preview: string;
  entryCount: number;
  header: NekHistoryEntry;
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
  /** Entries pages contain whole turns; target pages contain only the owner header and target entry. */
  view?: "entries" | "target";
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
/** Metadata-only boundary: no bodies or seed; cursors cover FULL turns. */
export interface NekHistorySummaryPage extends NekHistoryIdentity {
  view: "summary";
  turns: Array<Omit<NekHistoryTurn, "header"> & { headerEntryId: string; headerPosition: number }>;
  olderCursor?: string;
  newerCursor?: string;
  hasOlder: boolean;
  hasNewer: boolean;
  totalTurns: number;
  totalEntries: number;
}
export interface NekHistoryDirectory extends NekHistoryIdentity {
  items: { entryId: string; turnId: string; position: number; preview: string }[];
  hasMore: boolean;
  nextCursor?: string;
  totalTurns: number;
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
export interface NekHistorySubagentDirectory extends NekHistoryIdentity {
  kind: "subagents";
  subagents: NekHistorySubagentRecord[];
  total: number;
  count: number;
  hasMore: boolean;
  nextCursor?: string;
}
export type NekHistoryCommandResult<C extends NekHistoryCommand> = C extends {
  type: "read_history_subagent";
}
  ? C extends { subagentId: string }
    ? NekHistoryResult<NekHistorySubagent>
    : NekHistoryResult<NekHistorySubagentDirectory>
  : NekHistoryResponseData[C["type"]];
export interface NekHistoryResponseData {
  read_session_metadata: NekHistoryResult<NekHistoryMetadata>;
  read_history_page: NekHistoryResult<NekHistoryPage>;
  read_history_directory: NekHistoryResult<NekHistoryDirectory>;
  read_history_subagent: NekHistoryResult<NekHistorySubagent | NekHistorySubagentDirectory>;
}
