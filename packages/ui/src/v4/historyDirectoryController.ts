import type {
  ConversationHistory,
  ConversationHistoryDirectoryOptions,
  V4ConversationHistoryDirectoryResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ASYNC_ACTION_IDLE, reduceAsyncAction, type AsyncActionState } from "@/lib/asyncAction.js";
/** Minimal metadata owner port shared by parent stores and read-only child controllers. */
interface HistoryDirectorySource {
  getState(): {
    status: string;
    snapshot: { history?: ConversationHistory } | null;
    turnNavigatorDirectoryRevision: number;
    historyRequest?: string | null;
    historyError?: string | null;
  };
  subscribe(listener: () => void): () => void;
  getHistoryOwnerKey(): string;
  readHistoryDirectory(
    options: ConversationHistoryDirectoryOptions,
  ): Promise<V4ConversationHistoryDirectoryResult>;
}

const HISTORY_DIRECTORY_LIMITS = { page: 100, retained: 1000 } as const;
type HistoryDirectoryQuery = Omit<ConversationHistoryDirectoryOptions, "cursor">;
export interface HistoryDirectoryState {
  items: V4ConversationHistoryDirectoryResult["items"];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  totalTurns: number;
}
/** Validate before publishing metadata; owners may reuse it to retain the exact retry intent. */
export function assertHistoryDirectoryPage(
  result: V4ConversationHistoryDirectoryResult,
  cursor?: string,
): void {
  if (result.items.length > HISTORY_DIRECTORY_LIMITS.page)
    throw new Error("History directory page exceeds 100 summaries");
  if (
    result.hasMore &&
    (!result.nextCursor || result.nextCursor === cursor || !result.items.length)
  )
    throw new Error("History directory cursor did not advance");
}

const emptyState = (): HistoryDirectoryState => ({
  items: [],
  hasMore: false,
  loading: false,
  error: null,
  totalTurns: 0,
});
const queryKey = (query: HistoryDirectoryQuery) =>
  JSON.stringify([
    query.query ?? "",
    query.direction ?? "newest",
    query.aroundEntryId,
    query.limit,
  ]);

/** Query + owner generation fences metadata only. It never hydrates a conversation body. */
export function createHistoryDirectoryController(
  source: HistoryDirectorySource,
  initial: HistoryDirectoryQuery = {},
) {
  let query = initial;
  let state = emptyState();
  let action: AsyncActionState = ASYNC_ACTION_IDLE;
  let generation = 0;
  let closed = false;
  let started = false;
  let cursor: string | undefined;
  let owner = source.getHistoryOwnerKey();
  let directoryRevision = source.getState().turnNavigatorDirectoryRevision;
  const ready = () => {
    const ownerState = source.getState();
    return Boolean(
      ownerState.snapshot?.history &&
      ownerState.status === "live" &&
      ownerState.historyRequest !== "latest" &&
      !ownerState.historyError,
    );
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<HistoryDirectoryState>) => {
    state = {
      ...state,
      ...patch,
      loading: action.status === "pending",
      error: action.status === "error" ? action.message : null,
    };
    for (const listener of listeners) listener();
  };
  const reset = () => {
    generation++;
    action = ASYNC_ACTION_IDLE;
    started = false;
    cursor = undefined;
    state = emptyState();
  };
  async function read(append: boolean): Promise<void> {
    if (closed || action.status === "pending" || (append && !state.hasMore)) return;
    started = true;
    const requestGeneration = generation;
    const requestOwner = source.getHistoryOwnerKey();
    const requestCursor = append ? cursor : undefined;
    action = reduceAsyncAction(action, { type: "start" });
    publish({});
    try {
      const result = await source.readHistoryDirectory({
        ...query,
        limit: Math.min(
          HISTORY_DIRECTORY_LIMITS.page,
          Math.max(1, query.limit ?? HISTORY_DIRECTORY_LIMITS.page),
        ),
        ...(requestCursor ? { cursor: requestCursor } : {}),
      });
      if (
        closed ||
        generation !== requestGeneration ||
        requestOwner !== source.getHistoryOwnerKey()
      )
        return;
      assertHistoryDirectoryPage(result, requestCursor);
      const items = new Map((append ? state.items : []).map((item) => [item.entryId, item]));
      for (const item of result.items) items.set(item.entryId, item);
      /** Retain the requested end of the directory, not an unbounded completed-page cache. */
      const retained = [...items.values()].slice(-HISTORY_DIRECTORY_LIMITS.retained);
      cursor = result.nextCursor;
      action = reduceAsyncAction(action, { type: "resolve" });
      publish({ items: retained, totalTurns: result.totalTurns, hasMore: result.hasMore });
    } catch (error) {
      if (
        closed ||
        generation !== requestGeneration ||
        requestOwner !== source.getHistoryOwnerKey()
      )
        return;
      action = reduceAsyncAction(action, {
        type: "reject",
        message: error instanceof Error ? error.message : String(error),
      });
      publish({});
    }
  }
  const off = source.subscribe(() => {
    const nextOwner = source.getHistoryOwnerKey();
    const nextRevision = source.getState().turnNavigatorDirectoryRevision;
    if (owner === nextOwner && directoryRevision === nextRevision) {
      if (!started && ready()) void read(false);
      return;
    }
    owner = nextOwner;
    directoryRevision = nextRevision;
    reset();
    publish({});
    if (ready()) void read(false);
  });
  /** Factory creation is an effect: create/close it at the scope's commit boundary, not render. */
  if (ready()) void read(false);
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadMore: () => read(true),
    reload: () => read(false),
    setQuery(next: HistoryDirectoryQuery) {
      if (closed || queryKey(next) === queryKey(query)) return;
      query = next;
      reset();
      publish({});
      if (ready()) void read(false);
    },
    close() {
      if (closed) return;
      closed = true;
      generation++;
      off();
      listeners.clear();
    },
  };
}
