import type {
  ConversationHistoryDirectoryOptions,
  ConversationHistoryPageOptions,
} from "@zcode/shared/zcode-protocol-v4";
import { assertHistoryObservation, withHistoryObservation } from "@zcode/shared/zcode-protocol-v4";
import { ASYNC_ACTION_IDLE, reduceAsyncAction, type AsyncActionState } from "@/lib/asyncAction.js";
import {
  assertHistoryDirectoryPage,
  createHistoryDirectoryController,
} from "@/v4/historyDirectoryController.js";
import { buildSubagentHistoryControls } from "./subagentHistoryControls.js";
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
import {
  SUBAGENT_HISTORY_CLOCK,
  subagentHistoryScopeKey,
  subagentHistoryTarget,
  subagentHistoryReadTarget,
} from "./subagentHistoryTypes.js";
import {
  createSubagentHistoryReadLease,
  createSubagentHistoryPollTimer,
  observeSubagentHistoryRuntime,
} from "./subagentHistoryReadLease.js";
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** One owner per trusted tab scope. Construct/close at an effect boundary, never during render. */
export class SubagentHistoryConversation {
  private readonly body = new SubagentHistoryBody();
  private state: SubagentHistoryState = { error: null, retry: () => this.retry() };
  private readonly listeners = new Set<() => void>();
  private readonly directory;
  private readonly offDirectory: () => void;
  private readonly offRuntime: () => void;
  private readonly pollTimer: ReturnType<typeof createSubagentHistoryPollTimer>;
  private action: AsyncActionState = ASYNC_ACTION_IDLE;
  private generation = 0;
  private active = false;
  private closed = false;
  private resetting = false;
  private query = "";
  private readonly auxiliary = createSubagentHistoryReadLease({
    active: () => this.active && !this.closed && !this.body.stale,
    key: () => this.ownerKey(),
    watermark: () => this.body.watermark,
    observation: () => this.body.data?.history,
  });
  private failure?: { message: string; retry: () => Promise<unknown>; key?: string };
  private directoryRetry?: () => Promise<void>;
  constructor(
    private readonly service: SubagentHistoryService,
    private readonly scope: SubagentHistoryScope,
    options: { active?: boolean; query?: string; clock?: SubagentHistoryClock } = {},
  ) {
    this.pollTimer = createSubagentHistoryPollTimer(options.clock ?? SUBAGENT_HISTORY_CLOCK, () => {
      void this.refresh();
    });
    this.query = options.query ?? "";
    this.directory = createHistoryDirectoryController(
      {
        getState: () => ({
          status:
            this.active && this.body.data && !this.body.stale && !this.resetting && !this.failure
              ? "live"
              : "connecting",
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
      this.body.watermark?.atLogEpoch,
    ]);
  }
  private publish(): void {
    this.state = {
      data: this.body.data,
      error: this.failure?.message ?? this.directory.getState().error,
      retry: () => this.retry(),
      historyControls: this.body.data
        ? buildSubagentHistoryControls(
            this,
            this.body,
            this.directory,
            this.query,
            this.failure?.message ?? null,
            this.action.status === "pending",
          )
        : undefined,
    };
    for (const listener of this.listeners) listener();
  }
  private schedule(): void {
    this.pollTimer.schedule(
      this.valid(this.generation) &&
        !this.failure &&
        !this.body.stale &&
        this.body.data?.status === "running",
    );
  }
  private valid(generation: number): boolean {
    return !this.closed && this.active && this.generation === generation;
  }
  private assertCurrent(generation: number): void {
    if (!this.valid(generation)) throw new Error("Child history owner is no longer active");
  }
  private async run<T>(
    intent: (generation: number) => Promise<T>,
    reset = false,
  ): Promise<T | undefined> {
    if (!this.active || this.closed || this.action.status === "pending") return undefined;
    if (reset) {
      this.generation++;
      this.auxiliary.clear();
      this.resetting = true;
    }
    const generation = this.generation;
    this.pollTimer.clear();
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
        this.failure = { message, retry: () => this.run(intent, reset) };
        this.action = reduceAsyncAction(this.action, { type: "reject", message });
      }
      return undefined;
    } finally {
      if (this.valid(generation)) {
        this.resetting = false;
        this.publish();
        this.schedule();
      }
    }
  }
  private refresh(fresh = false): Promise<boolean | undefined> {
    return this.run(async (generation) => {
      const params = withHistoryObservation(
        { ...subagentHistoryTarget(this.scope), id: this.scope.childSessionId, turnLimit: 20 },
        fresh ? undefined : this.body.data?.history.observationCursor,
      );
      const preview = await this.service.getSubagentConversation(params);
      this.assertCurrent(generation);
      this.body.applyPreview(preview, fresh, params.observationCursor);
      return true;
    }, fresh);
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
      ...subagentHistoryReadTarget(this.scope),
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
    return Boolean(
      await this.run(
        (generation) => this.readPage(generation, direction, options),
        direction === "latest",
      ),
    );
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
  loadAround = (id: string): Promise<boolean> => this.page("around", { aroundEntryId: id });
  loadLatest = (): Promise<boolean> => this.page("latest");
  async loadOldest(): Promise<string | null> {
    const turnId = await this.run(async (generation) => {
      const history = this.body.data?.history;
      const params = withHistoryObservation(
        { ...subagentHistoryReadTarget(this.scope), direction: "oldest" as const, limit: 1 },
        history?.observationCursor,
      );
      const result = await this.service.conversationHistoryDirectoryV4(params);
      this.assertCurrent(generation);
      assertChildWatermark(result, this.body.watermark);
      if (history) assertHistoryObservation(history, result, params.observationCursor);
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
  private async readDirectory(options: ConversationHistoryDirectoryOptions) {
    const generation = this.generation;
    const ownerKey = this.ownerKey();
    const query = this.query;
    const previous = this.failure;
    try {
      const params = withHistoryObservation(
        {
          ...options,
          ...subagentHistoryReadTarget(this.scope),
          limit: Math.min(100, Math.max(1, options.limit ?? 20)),
        },
        this.body.data?.history.observationCursor,
      );
      const result = await this.auxiliary.read(
        () => this.service.conversationHistoryDirectoryV4(params),
        params.observationCursor,
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
    this.pollTimer.clear();
    this.action = ASYNC_ACTION_IDLE;
    this.resetting = false;
    this.auxiliary.clear();
    this.publish();
    if (active && !this.body.stale) void this.refresh();
  }
  private invalidateRuntime(): void {
    if (this.closed) return;
    this.generation++;
    this.pollTimer.clear();
    this.action = ASYNC_ACTION_IDLE;
    this.resetting = false;
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
    this.pollTimer.clear();
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
