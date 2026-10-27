import type {
  NekSessionIndexEntry,
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

/** 超出上限时保留的顺序：置顶 → 有效 → 最近打开。 */
function compareEntries(left: NekSessionIndexEntry, right: NekSessionIndexEntry): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  if (left.invalid !== right.invalid) return left.invalid ? 1 : -1;
  const leftTime = left.lastOpenedAt ?? "";
  const rightTime = right.lastOpenedAt ?? "";
  if (leftTime === rightTime) return 0;
  return leftTime < rightTime ? 1 : -1;
}

/**
 * 对账 nek 会话目录与 GUI 元数据，不复制会话内容。
 *
 * GUI 只保存自己的元数据（置顶、归档、未读、分组、最后打开时间）；标题、消息数、时间戳一律以
 * `list_sessions` 为准。对账规则：
 * - nek 里还在的会话保留本地元数据（失效标记清掉）；
 * - nek 里新出现的会话补一条默认元数据；
 * - 完整目录对账（`all` 或未指定 cwd）时，nek 已删除的会话标 `invalid`，不删本地元数据；
 * - 只按 cwd 对账时不能把别的工作区的条目误标为失效。
 *
 * 所有读改写都串行执行：置顶、清未读、对账同时发生时不丢更新。
 */
export class NekSessionIndexSyncer {
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private foregroundSessionPath: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NekSessionIndexSyncerOptions) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? (() => new Date());
  }

  async sync(options: NekSessionIndexSyncOptions = {}): Promise<NekSessionIndexSyncResult> {
    if (options.foregroundSessionPath !== undefined) {
      this.foregroundSessionPath = options.foregroundSessionPath;
    }
    return await this.runExclusive(async () => await this.syncNow(options));
  }

  async markOpened(sessionPath: string): Promise<NekSessionIndexEntry> {
    this.foregroundSessionPath = sessionPath;
    return await this.update(sessionPath, {
      unread: false,
      invalid: false,
      lastOpenedAt: this.now().toISOString(),
    });
  }

  /** 前台会话变化时调用；前台会话的回合完成不置未读。 */
  setForeground(sessionPath: string | undefined): void {
    this.foregroundSessionPath = sessionPath;
  }

  async markTurnCompleted(
    sessionPath: string,
    foregroundSessionPath = this.foregroundSessionPath,
  ): Promise<void> {
    if (sessionPath === foregroundSessionPath) return;
    await this.update(sessionPath, { unread: true });
  }

  async update(
    sessionPath: string,
    patch: Partial<Omit<NekSessionIndexEntry, "sessionPath">>,
  ): Promise<NekSessionIndexEntry> {
    return await this.runExclusive(async () => {
      const document = await this.options.storage.load();
      const entries = document.entries.map((entry) => ({ ...entry }));
      const existing = entries.find((candidate) => candidate.sessionPath === sessionPath);
      const entry = existing ?? this.defaultMetadata(sessionPath);
      if (!existing) entries.push(entry);
      Object.assign(entry, patch);
      const trimmed = this.trim(entries);
      await this.options.storage.save({ version: 1, entries: trimmed });
      return { ...(trimmed.find((candidate) => candidate.sessionPath === sessionPath) ?? entry) };
    });
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

  private async syncNow(options: NekSessionIndexSyncOptions): Promise<NekSessionIndexSyncResult> {
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
      items: entries.map((entry) => ({
        summary: byPath.get(entry.sessionPath),
        metadata: { ...entry },
      })),
      added,
      invalidated,
      restored,
    };
  }

  private defaultMetadata(sessionPath: string): NekSessionIndexEntry {
    return { sessionPath, pinned: false, archived: false, unread: false };
  }

  private trim(entries: NekSessionIndexEntry[]): NekSessionIndexEntry[] {
    if (entries.length <= this.maxEntries) return entries;
    return entries.sort(compareEntries).slice(0, this.maxEntries);
  }

  private runExclusive<T>(critical: () => Promise<T>): Promise<T> {
    const result = this.tail.then(critical, critical);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
