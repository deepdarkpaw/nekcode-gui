import type {
  ConversationHistoryContentOptions,
  ConversationHistoryDirectoryOptions,
  ConversationHistoryPageOptions,
} from "@zcode/shared/zcode-protocol-v4";
import { ASYNC_ACTION_IDLE, reduceAsyncAction, type AsyncActionState } from "@/lib/asyncAction.js";
import {
  assertHistoryDirectoryPage,
  createHistoryDirectoryController,
} from "@/v4/historyDirectoryController.js";
import type { ConversationHistoryControls } from "@/v4/useConversationHistoryControls.js";
import { NEK_STATUS_TRANSCRIPT_REFRESH_MS } from "./types.js";
import {
  SubagentHistoryBody,
  assertChildWatermark,
  type ChildPageDirection,
} from "./subagentHistoryBody.js";
import type {
  SubagentHistoryClock,
  SubagentHistoryScope,
  SubagentHistoryService,
  SubagentHistoryState,
} from "./subagentHistoryTypes.js";
import { subagentHistoryScopeKey } from "./subagentHistoryTypes.js";
import {
  createSubagentHistoryReadLease,
  observeSubagentHistoryRuntime,
} from "./subagentHistoryReadLease.js";
const nativeClock: SubagentHistoryClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
/** One caller-visible raw JSON chunk, never an accumulated full body. */
const CONTENT_CHUNK_BYTES = 64 * 1024;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** One owner per trusted tab scope. Construct/close at an effect boundary, never during render. */
export class SubagentHistoryConversation {
  private readonly body = new SubagentHistoryBody();
  private state: SubagentHistoryState = { error: null, retry: () => this.retry() };
  private readonly listeners = new Set<() => void>();
  private readonly directory;
  private readonly offDirectory: () => void;
  private readonly offRuntime: () => void;
  private readonly clock: SubagentHistoryClock;
  private timer?: ReturnType<typeof setTimeout>;
  private action: AsyncActionState = ASYNC_ACTION_IDLE;
  private generation = 0;
  private active = false;
  private closed = false;
  private query = "";
  private readonly auxiliary = createSubagentHistoryReadLease({
    active: () => this.active && !this.closed && !this.body.stale,
    key: () => this.ownerKey(),
    watermark: () => this.body.watermark,
  });
  private failure?: { message: string; retry: () => Promise<unknown>; key?: string };
  private directoryRetry?: () => Promise<void>;
  constructor(
    private readonly service: SubagentHistoryService,
    private readonly scope: SubagentHistoryScope,
    options: { active?: boolean; query?: string; clock?: SubagentHistoryClock } = {},
  ) {
    this.clock = options.clock ?? nativeClock;
    this.query = options.query ?? "";
    this.directory = createHistoryDirectoryController(
      {
        getState: () => ({
          status: this.active && this.body.data && !this.body.stale ? "live" : "connecting",
          snapshot: this.body.data ? { history: this.body.data.history } : null,
          turnNavigatorDirectoryRevision: this.body.directoryRevision,
        }),
        subscribe: (listener) => this.subscribe(listener),
        getHistoryOwnerKey: () => this.ownerKey(),
        readHistoryDirectory: (params) => this.readDirectory(params),
      },
      { query: this.query, direction: "newest", limit: 20 },
    );
    this.offDirectory = this.directory.subscribe(() => this.publish());
    this.offRuntime = observeSubagentHistoryRuntime(service, scope, () => this.invalidateRuntime());
    this.setActive(options.active ?? true);
  }
  getState = (): SubagentHistoryState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private ownerKey(): string {
    return JSON.stringify([
      subagentHistoryScopeKey(this.scope),
      this.generation,
      this.body.data?.history.branchRevision,
      this.body.watermark?.atLogEpoch,
    ]);
  }
  private target() {
    return {
      workspacePath: this.scope.workspacePath,
      workspaceIdentity: this.scope.workspaceIdentity,
      remoteSessionId: this.scope.remoteSessionId,
      sessionId: this.scope.parentSessionId,
    };
  }
  private historyTarget() {
    return { ...this.target(), subagentId: this.scope.childSessionId };
  }
  private publish(): void {
    this.state = {
      data: this.body.data,
      error: this.failure?.message ?? this.directory.getState().error,
      retry: () => this.retry(),
      historyControls: this.body.data ? this.controls() : undefined,
    };
    for (const listener of this.listeners) listener();
  }
  private controls(): ConversationHistoryControls {
    return {
      history: this.body.history!,
      directory: {
        ...this.directory.getState(),
        loadMore: () => this.directory.loadMore(),
        reload: () => this.directory.reload(),
      },
      directoryQuery: this.query,
      error: this.failure?.message ?? null,
      loading: this.action.status === "pending",
      truncatedTurns: this.body.window.omissions,
      loadOlder: () => this.loadOlder(),
      loadNewer: () => this.loadNewer(),
      loadAround: (id) => this.loadAround(id),
      loadLatest: () => this.loadLatest(),
      loadOldest: () => this.loadOldest(),
      loadTurn: (id, cursor) => this.loadTurn(id, cursor),
      readContent: (options) => this.readContent(options),
      retry: () => this.retry(),
    };
  }
  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(): void {
    this.clearTimer();
    if (
      !this.active ||
      this.closed ||
      this.failure ||
      this.body.stale ||
      this.body.data?.status !== "running"
    )
      return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  }
  private valid(generation: number): boolean {
    return !this.closed && this.active && this.generation === generation;
  }
  private assertCurrent(generation: number): void {
    if (!this.valid(generation)) throw new Error("Child history owner is no longer active");
  }
  private async run<T>(intent: (generation: number) => Promise<T>): Promise<T | undefined> {
    if (!this.active || this.closed || this.action.status === "pending") return undefined;
    const generation = this.generation;
    this.clearTimer();
    this.failure = undefined;
    this.action = reduceAsyncAction(this.action, { type: "start" });
    this.publish();
    try {
      const result = await intent(generation);
      this.assertCurrent(generation);
      this.action = reduceAsyncAction(this.action, { type: "resolve" });
      return result;
    } catch (error) {
      if (this.valid(generation)) {
        const message = messageOf(error);
        this.failure = { message, retry: () => this.run(intent) };
        this.action = reduceAsyncAction(this.action, { type: "reject", message });
      }
      return undefined;
    } finally {
      if (this.valid(generation)) {
        this.publish();
        this.schedule();
      }
    }
  }
  private refresh(fresh = false): Promise<boolean | undefined> {
    return this.run(async (generation) => {
      const preview = await this.service.getSubagentConversation({
        ...this.target(),
        id: this.scope.childSessionId,
        turnLimit: 20,
      });
      this.assertCurrent(generation);
      this.body.applyPreview(preview, fresh);
      return true;
    });
  }
  private async readPage(
    generation: number,
    direction: ChildPageDirection,
    options: ConversationHistoryPageOptions = {},
  ): Promise<boolean> {
    if (!this.body.data) throw new Error("Child history has not loaded yet");
    const params = this.body.pageOptions(direction, options);
    if (!params) return false;
    const result = await this.service.conversationHistoryPageV4({
      ...params,
      ...this.historyTarget(),
      turnLimit: 20,
    });
    this.assertCurrent(generation);
    this.body.applyPage(result, direction, params);
    return true;
  }
  private async page(
    direction: ChildPageDirection,
    options: ConversationHistoryPageOptions = {},
  ): Promise<boolean> {
    if (!this.body.data && direction === "latest") return Boolean(await this.refresh(true));
    return Boolean(await this.run((generation) => this.readPage(generation, direction, options)));
  }
  private throwFailure(): void {
    if (this.failure) throw new Error(this.failure.message);
  }
  async loadOlder(): Promise<void> {
    await this.page("older");
    this.throwFailure();
  }
  async loadNewer(): Promise<void> {
    await this.page("newer");
    this.throwFailure();
  }
  loadAround(entryId: string): Promise<boolean> {
    return this.page("around", { aroundEntryId: entryId });
  }
  loadLatest(): Promise<boolean> {
    return this.page("latest");
  }
  async loadOldest(): Promise<string | null> {
    const turnId = await this.run(async (generation) => {
      const result = await this.service.conversationHistoryDirectoryV4({
        ...this.historyTarget(),
        direction: "oldest",
        limit: 1,
      });
      this.assertCurrent(generation);
      assertChildWatermark(result, this.body.watermark);
      const entry = result.items[0];
      if (!entry && (result.totalTurns > 0 || this.body.data?.history.totalTurns))
        throw new Error("Child history directory omitted the oldest turn");
      if (!entry) return null;
      return (await this.readPage(generation, "around", { aroundEntryId: entry.entryId }))
        ? entry.turnId
        : null;
    });
    return turnId ?? null;
  }
  async loadTurn(turnId: string, cursor?: string): Promise<void> {
    await this.run(async (generation) => {
      if (!this.body.data || this.body.stale)
        throw new Error("Child history is unavailable; load latest explicitly");
      const result = await this.service.conversationHistoryTurnV4({
        ...this.historyTarget(),
        turnId,
        ...(cursor ? { cursor } : {}),
      });
      this.assertCurrent(generation);
      this.body.applyTurn(result, turnId, cursor);
    });
    this.throwFailure();
  }
  private async readDirectory(options: ConversationHistoryDirectoryOptions) {
    const generation = this.generation;
    const ownerKey = this.ownerKey();
    const query = this.query;
    const previous = this.failure;
    try {
      const result = await this.auxiliary.read(() =>
        this.service.conversationHistoryDirectoryV4({
          ...options,
          ...this.historyTarget(),
          limit: Math.min(100, Math.max(1, options.limit ?? 20)),
        }),
      );
      assertHistoryDirectoryPage(result, options.cursor);
      if (
        !options.query &&
        (result.totalTurns > 0 || this.body.data?.history.totalTurns) &&
        !result.items.length
      )
        throw new Error("Child history directory omitted its summaries");
      if (this.valid(generation) && ownerKey === this.ownerKey() && query === this.query)
        this.directoryRetry = undefined;
      if (
        this.valid(generation) &&
        ownerKey === this.ownerKey() &&
        query === this.query &&
        this.failure === previous
      ) {
        this.failure = undefined;
        this.publish();
      }
      return result;
    } catch (error) {
      if (this.valid(generation) && ownerKey === this.ownerKey() && query === this.query) {
        this.directoryRetry = () =>
          options.cursor ? this.directory.loadMore() : this.directory.reload();
        this.failure = { message: messageOf(error), retry: this.directoryRetry };
        this.publish();
      }
      throw error;
    }
  }
  async readContent(options: ConversationHistoryContentOptions) {
    const generation = this.generation;
    const ownerKey = this.ownerKey();
    const params = {
      ...options,
      limit: Math.min(CONTENT_CHUNK_BYTES, Math.max(1, options.limit ?? CONTENT_CHUNK_BYTES)),
    };
    const key = JSON.stringify(params);
    try {
      const result = await this.auxiliary.read(() =>
        this.service.conversationHistoryContentV4({ ...params, ...this.historyTarget() }),
      );
      this.assertCurrent(generation);
      if (ownerKey !== this.ownerKey()) throw new Error("Child history owner changed during read");
      if (this.failure?.key === key) this.failure = undefined;
      this.publish();
      return result;
    } catch (error) {
      if (this.valid(generation) && ownerKey === this.ownerKey()) {
        this.failure = { message: messageOf(error), retry: () => this.readContent(params), key };
        this.publish();
      }
      throw error;
    }
  }
  async retry(): Promise<unknown> {
    if (!this.active || this.closed) return;
    const retry =
      this.failure?.retry ?? (this.directory.getState().error ? this.directoryRetry : undefined);
    this.failure = undefined;
    return retry ? retry() : undefined;
  }
  setQuery(query: string): void {
    if (query === this.query || this.closed) return;
    this.query = query;
    this.failure = undefined;
    this.directoryRetry = undefined;
    this.directory.setQuery({ query, direction: "newest", limit: 20 });
    this.publish();
  }
  setActive(active: boolean): void {
    if (this.closed || this.active === active) return;
    this.active = active;
    this.generation++;
    this.clearTimer();
    this.action = ASYNC_ACTION_IDLE;
    this.auxiliary.clear();
    this.publish();
    if (active && !this.body.stale) void this.refresh();
  }
  private invalidateRuntime(): void {
    if (this.closed) return;
    this.generation++;
    this.clearTimer();
    this.action = ASYNC_ACTION_IDLE;
    this.body.stale = true;
    this.auxiliary.clear();
    this.failure = {
      message: "Child history runtime changed; load latest explicitly",
      retry: () => this.loadLatest(),
    };
    this.publish();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.clearTimer();
    this.directory.close();
    this.offDirectory();
    this.offRuntime();
    this.listeners.clear();
    this.auxiliary.clear();
  }
}

export function createSubagentHistoryConversation(
  service: SubagentHistoryService,
  scope: SubagentHistoryScope,
  options: { active?: boolean; query?: string; clock?: SubagentHistoryClock } = {},
) {
  return new SubagentHistoryConversation(service, { ...scope }, options);
}
