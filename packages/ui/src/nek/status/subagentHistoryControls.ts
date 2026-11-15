import type { ConversationHistoryControls } from "@/v4/useConversationHistoryControls.js";
import type { createHistoryDirectoryController } from "@/v4/historyDirectoryController.js";
import type { SubagentHistoryBody } from "./subagentHistoryBody.js";

type HistoryActions = Pick<
  ConversationHistoryControls,
  "loadOlder" | "loadNewer" | "loadAround" | "loadLatest" | "loadOldest" | "retry"
>;

/** Pure view projection; the controller retains all state. Pages are whole turns only. */
export function buildSubagentHistoryControls(
  owner: HistoryActions,
  body: Pick<SubagentHistoryBody, "history">,
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
    loadOlder: () => owner.loadOlder(),
    loadNewer: () => owner.loadNewer(),
    loadAround: (id) => owner.loadAround(id),
    loadLatest: () => owner.loadLatest(),
    loadOldest: () => owner.loadOldest(),
    retry: () => owner.retry(),
  };
}
