import type { NekSessionSummary } from "@zcode/shared/nek-protocol";

/** GUI 自己持有的会话元数据；对话内容和标题仍由 nek 会话文件提供。 */
export interface NekSessionIndexEntry {
  sessionPath: string;
  pinned: boolean;
  archived: boolean;
  unread: boolean;
  group?: string;
  lastOpenedAt?: string;
  invalid?: boolean;
}

export interface NekSessionIndexDocument {
  version: 1;
  entries: NekSessionIndexEntry[];
}

export interface NekSessionIndexStorage {
  load(): Promise<NekSessionIndexDocument>;
  save(document: NekSessionIndexDocument): Promise<void>;
}

export interface NekSessionIndexSyncOptions {
  cwd?: string;
  all?: boolean;
  limit?: number;
  foregroundSessionPath?: string;
}

export interface NekSessionIndexItem {
  summary?: NekSessionSummary;
  metadata: NekSessionIndexEntry;
}

export interface NekSessionIndexSyncResult {
  items: NekSessionIndexItem[];
  added: string[];
  invalidated: string[];
  restored: string[];
}

export interface NekSessionIndexListSource {
  (options: { cwd?: string; all?: boolean; limit?: number }): Promise<NekSessionSummary[]>;
}
