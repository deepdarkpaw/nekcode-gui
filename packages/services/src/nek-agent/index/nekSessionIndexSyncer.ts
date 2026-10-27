import type { NekSessionSummary } from "@zcode/shared/nek-protocol";
import type {
  NekSessionIndexEntry,
  NekSessionIndexItem,
  NekSessionIndexListSource,
  NekSessionIndexStorage,
  NekSessionIndexSyncOptions,
  NekSessionIndexSyncResult,
} from "./types.js";

const DEFAULT_MAX_ENTRIES = 5_000;

export interface NekSessionIndexSyncerOptions {
  storage: NekSessionIndexStorage;
  listSessions: NekSessionIndexListSource;
  maxEntries?: number;
  now?: () => Date;
}

/** 对账 nek 会话目录与 GUI 元数据，不复制会话内容。 */
export class NekSessionIndexSyncer {
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private foregroundSessionPath: string | undefined;

  constructor(private readonly options: NekSessionIndexSyncerOptions) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? (() => new Date());
  }

  async sync(options: NekSessionIndexSyncOptions = {}): Promise<NekSessionIndexSyncResult> {
    const document = await this.options.storage.load();
    const summaries = await this.options.listSessions({
      cwd: options.cwd,
      all: options.all,
      limit: options.limit,
    });
    const byPath = new Map(summaries.map((summary) => [summary.path, summary]));
    const metadata = new Map(document.entries.map((entry) => [entry.sessionPath, { ...entry }]));
    const added: string[] = [];
    const invalidated: string[] = [];
    const restored: string[] = [];

    for (const summary of summaries) {
      const current = metadata.get(summary.path);
      if (!current) {
        metadata.set(summary.path, this.defaultMetadata(summary.path));
        added.push(summary.path);
        continue;
      }
      if (current.invalid) restored.push(summary.path);
      current.invalid = false;
    }

    // 只有 all 对账才有完整目录；cwd 对账不能把其他工作区的条目误标为失效。
    const completeCatalog = options.all === true || options.cwd === undefined;
    if (completeCatalog) {
      for (const entry of metadata.values()) {
        if (entry.invalid || byPath.has(entry.sessionPath)) continue;
        entry.invalid = true;
        invalidated.push(entry.sessionPath);
      }
    }

    const entries = this.trim([...metadata.values()]);
    await this.options.storage.save({ version: 1, entries });
    return {
      items: entries.map((entry) => ({ summary: byPath.get(entry.sessionPath), metadata: entry })),
      added,
      invalidated,
      restored,
    };
  }

  async markOpened(sessionPath: string): Promise<NekSessionIndexEntry> {
    this.foregroundSessionPath = sessionPath;
    return await this.update(sessionPath, {
      unread: false,
      invalid: false,
      lastOpenedAt: this.now().toISOString(),
    });
  }

  setForeground(sessionPath: string | undefined): void {
    this.foregroundSessionPath = sessionPath;
  }

  async markTurnCompleted(sessionPath: string, foregroundSessionPath = this.foregroundSessionPath): Promise<void> {
    if (sessionPath === foregroundSessionPath) return;
    await this.update(sessionPath, { unread: true });
  }

  async update(
    sessionPath: string,
    patch: Partial<Omit<NekSessionIndexEntry, "sessionPath">>,
  ): Promise<NekSessionIndexEntry> {
    const document = await this.options.storage.load();
    const entries = document.entries.map((entry) => ({ ...entry }));
    let entry = entries.find((candidate) => candidate.sessionPath === sessionPath);
    if (!entry) {
      entry = this.defaultMetadata(sessionPath);
      entries.push(entry);
    }
    Object.assign(entry, patch);
    const trimmed = this.trim(entries);
    await this.options.storage.save({ version: 1, entries: trimmed });
    return { ...(trimmed.find((candidate) => candidate.sessionPath === sessionPath) ?? entry) };
  }

  async setPinned(sessionPath: string, pinned: boolean): Promise<NekSessionIndexEntry> {
    return await this.update(sessionPath, { pinned });
  }

  async setArchived(sessionPath: string, archived: boolean): Promise<NekSessionIndexEntry> {
    return await this.update(sessionPath, { archived });
  }

  async setGroup(sessionPath: string, group: string | undefined): Promise<NekSessionIndexEntry> {
    return await this.update(sessionPath, group === undefined ? { group: undefined } : { group });
  }

  private defaultMetadata(sessionPath: string): NekSessionIndexEntry {
    return { sessionPath, pinned: false, archived: false, unread: false };
  }

  private trim(entries: NekSessionIndexEntry[]): NekSessionIndexEntry[] {
    if (entries.length <= this.maxEntries) return entries;
    return entries
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        const leftTime = left.lastOpenedAt ?? "";
        const rightTime = right.lastOpenedAt ?? "";
        return rightTime.localeCompare(leftTime);
      })
      .slice(0, this.maxEntries);
  }
}

export function sessionSummaryMap(summaries: readonly NekSessionSummary[]): Map<string, NekSessionSummary> {
  return new Map(summaries.map((summary) => [summary.path, summary]));
}
