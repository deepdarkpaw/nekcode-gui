import type { ConversationHistoryControls } from "@/v4/useConversationHistoryControls.js";
import type { createHistoryDirectoryController } from "@/v4/historyDirectoryController.js";
import type { SubagentHistoryBody } from "./subagentHistoryBody.js";

type HistoryActions = Pick<
  ConversationHistoryControls,
  | "loadOlder"
  | "loadNewer"
  | "loadAround"
  | "loadLatest"
  | "loadOldest"
  | "loadTurn"
  | "readContent"
  | "retry"
>;

/** Pure view projection; the controller retains all state and the stable bound content callback. */
export function buildSubagentHistoryControls(
  owner: HistoryActions,
  body: Pick<SubagentHistoryBody, "history" | "window">,
  directory: ReturnType<typeof createHistoryDirectoryController>,
  query: string,
  error: string | null,
  loading: boolean,
): ConversationHistoryControls {
  return {
    history: body.history!,
    directory: {
      ...directory.getState(),
      loadMore: () => directory.loadMore(),
      reload: () => directory.reload(),
    },
    directoryQuery: query,
    error,
    loading,
    truncatedTurns: body.window.omissions,
    loadOlder: () => owner.loadOlder(),
    loadNewer: () => owner.loadNewer(),
    loadAround: (id) => owner.loadAround(id),
    loadLatest: () => owner.loadLatest(),
    loadOldest: () => owner.loadOldest(),
    loadTurn: (id, cursor) => owner.loadTurn(id, cursor),
    readContent: owner.readContent,
    retry: () => owner.retry(),
  };
}
