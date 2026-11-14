import { useCallback, useMemo, useRef } from "react";
import type {
  ConversationHistory,
  ConversationHistoryContentOptions,
  V4ConversationHistoryContentResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationProjectionStore } from "./conversationProjectionStore.js";
import type { ConversationTurnDirectory } from "./ConversationTurnNavigator.js";
import { useConversationHistoryDirectory } from "./useConversationHistoryDirectory.js";

export interface ConversationHistoryControls {
  history: ConversationHistory;
  directory: Omit<ConversationTurnDirectory, "onNavigate">;
  directoryQuery: string | null;
  error: string | null;
  loading: boolean;
  truncatedTurns: readonly { turnId: string; reason: "budget" }[];
  loadAround(entryId: string): Promise<boolean>;
  loadOldest(): Promise<string | null>;
  loadLatest(): Promise<boolean>;
  loadOlder(): Promise<void>;
  loadNewer(): Promise<void>;
  loadTurn(turnId: string, cursor?: string): Promise<void>;
  readContent(
    options: ConversationHistoryContentOptions,
  ): Promise<V4ConversationHistoryContentResult>;
  retry(): Promise<unknown>;
}

/** Thin UI actions over the store owner; retry retains the failed user intent, not an accepted queue. */
export function useConversationHistoryControls(
  store: ConversationProjectionStore | undefined,
  query = "",
): ConversationHistoryControls | undefined {
  const state = store?.getState();
  const history = state?.snapshot?.history;
  const directory = useConversationHistoryDirectory(store, Boolean(history), query);
  const lastAction = useRef<
    { store: ConversationProjectionStore; run: () => Promise<unknown> } | undefined
  >(undefined);
  const run = useCallback(
    async <T>(action: () => Promise<T>) => {
      if (!store) throw new Error("Conversation history is no longer available");
      lastAction.current = { store, run: action };
      return await action();
    },
    [store],
  );
  const loadAround = useCallback(
    async (entryId: string) => Boolean(await run(() => store!.loadAround(entryId))),
    [run, store],
  );
  const loadLatest = useCallback(
    async () => Boolean(await run(() => store!.loadLatest())),
    [run, store],
  );
  const loadOlder = useCallback(() => run(() => store!.loadOlder()), [run, store]);
  const loadNewer = useCallback(() => run(() => store!.loadNewer()), [run, store]);
  const loadOldest = useCallback(
    () =>
      run(async () => {
        const result = await store!.readHistoryDirectory({ direction: "oldest", limit: 1 });
        const first = result.items[0];
        if (!first || !(await store!.loadAround(first.entryId))) return null;
        return first.turnId;
      }),
    [run, store],
  );
  const loadTurn = useCallback(
    (turnId: string, cursor?: string) =>
      run(async () => {
        const result = await store!.loadHistoryTurn(turnId, cursor);
        if (!result)
          throw new Error(store!.getState().historyError ?? "History read became stale; retry");
      }),
    [run, store],
  );
  const readContent = useCallback(
    (options: ConversationHistoryContentOptions) => {
      if (!store) return Promise.reject(new Error("Conversation history is no longer available"));
      return store.readHistoryContent(options);
    },
    [store],
  );
  const retry = useCallback(async () => {
    const previous = lastAction.current;
    if (previous && previous.store === store) return await previous.run();
    return await store?.loadOlder();
  }, [store]);
  return useMemo(
    () =>
      history
        ? {
            history,
            directory,
            directoryQuery: directory.query,
            error: state?.historyError ?? null,
            loading: Boolean(state?.historyRequest),
            truncatedTurns: state?.historyTruncatedTurns ?? [],
            loadAround,
            loadLatest,
            loadOlder,
            loadNewer,
            loadOldest,
            loadTurn,
            readContent,
            retry,
          }
        : undefined,
    [
      history,
      directory,
      state?.historyError,
      state?.historyRequest,
      state?.historyTruncatedTurns,
      loadAround,
      loadLatest,
      loadOlder,
      loadNewer,
      loadOldest,
      loadTurn,
      readContent,
      retry,
    ],
  );
}
