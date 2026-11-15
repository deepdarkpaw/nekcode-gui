import { useCallback, useMemo, useRef } from "react";
import type { ConversationHistory } from "@zcode/shared/zcode-protocol-v4";
import type { HistoryViewportAnchor } from "./conversationHistoryBoundary.js";
import { HISTORY_BOUNDARY_REFRESH_REQUIRED } from "./conversationHistoryWindow.js";
import type { ConversationProjectionStore } from "./conversationProjectionStore.js";
import type { ConversationTurnDirectory } from "./ConversationTurnNavigator.js";
import { useConversationHistoryDirectory } from "./useConversationHistoryDirectory.js";

/** History pages are whole turns only: older/newer pages add complete turns, never turn slices. */
export interface ConversationHistoryControls {
  history: ConversationHistory;
  directory: Omit<ConversationTurnDirectory, "onNavigate">;
  directoryQuery: string | null;
  error: string | null;
  loading: boolean;
  loadAround(entryId: string): Promise<boolean>;
  loadOldest(): Promise<string | null>;
  loadLatest(): Promise<boolean>;
  loadOlder(): Promise<void>;
  loadNewer(): Promise<void>;
  retry(): Promise<unknown>;
  /** Main Timeline calls from scroll/effect, never render. */
  setViewportAnchor?(anchor: HistoryViewportAnchor): void;
  /** Explicit retry for live preview/transport errors; no model input replay. */
  resyncHistory?(): void;
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
  const setViewportAnchor = useCallback(
    (anchor: HistoryViewportAnchor) => store?.setViewportAnchor(anchor),
    [store],
  );
  const resyncHistory = useCallback(() => store?.resyncHistory(), [store]);
  const retry = useCallback(async () => {
    if (store?.getState().historyError === HISTORY_BOUNDARY_REFRESH_REQUIRED)
      return await run(() => store.loadLatest());
    const previous = lastAction.current;
    if (previous && previous.store === store) return await previous.run();
    return await store?.loadOlder();
  }, [run, store]);
  return useMemo(
    () =>
      history
        ? {
            history,
            directory,
            directoryQuery: directory.query,
            error: state?.historyError ?? null,
            loading: Boolean(state?.historyRequest),
            loadAround,
            loadLatest,
            loadOlder,
            loadNewer,
            loadOldest,
            setViewportAnchor,
            resyncHistory,
            retry,
          }
        : undefined,
    [
      history,
      directory,
      state?.historyError,
      state?.historyRequest,
      loadAround,
      loadLatest,
      loadOlder,
      loadNewer,
      loadOldest,
      setViewportAnchor,
      resyncHistory,
      retry,
    ],
  );
}
