import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ConversationProjectionStore } from "./conversationProjectionStore.js";
import {
  createHistoryDirectoryController,
  type HistoryDirectoryState,
} from "./historyDirectoryController.js";

const EMPTY_DIRECTORY: HistoryDirectoryState = {
  items: [],
  hasMore: false,
  loading: false,
  error: null,
  totalTurns: 0,
};
const subscribeEmpty = () => () => undefined;
const readEmpty = () => EMPTY_DIRECTORY;

/** React owns a metadata-controller lease; no request starts during render. */
export function useConversationHistoryDirectory(
  store: ConversationProjectionStore | undefined,
  enabled: boolean,
  query = "",
) {
  const [owner, setOwner] = useState<{
    store: ConversationProjectionStore;
    controller: ReturnType<typeof createHistoryDirectoryController>;
  }>();
  const [settledQuery, setSettledQuery] = useState(query);
  const [appliedQuery, setAppliedQuery] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!store || !enabled) return;
    const controller = createHistoryDirectoryController(store, { direction: "newest", limit: 20 });
    setOwner({ store, controller });
    return () => controller.close();
  }, [store, enabled]);
  const controller = enabled && owner?.store === store ? owner?.controller : undefined;
  useEffect(() => {
    if (!controller) {
      setAppliedQuery(null);
      return;
    }
    controller.setQuery({
      direction: "newest",
      limit: 20,
      ...(settledQuery ? { query: settledQuery } : {}),
    });
    setAppliedQuery(settledQuery);
  }, [controller, settledQuery]);
  const state = useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    controller?.getState ?? readEmpty,
    readEmpty,
  );
  return {
    ...state,
    query: appliedQuery,
    loadMore: useCallback(() => controller?.loadMore(), [controller]),
    reload: useCallback(() => controller?.reload(), [controller]),
  };
}
