import type { IZCodeAgentService } from "@zcode/services";
import type { SubagentSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { ConversationHistoryControls } from "@/v4/useConversationHistoryControls.js";
import type { SubagentConversation } from "./useSubagentConversation.js";

export type SubagentHistoryScope = Pick<
  SubagentSessionSidePaneTab,
  | "workspacePath"
  | "workspaceIdentity"
  | "remoteSessionId"
  | "rootSessionId"
  | "parentSessionId"
  | "childSessionId"
>;
export type SubagentHistoryService = Pick<
  IZCodeAgentService,
  | "getSubagentConversation"
  | "conversationHistoryPageV4"
  | "conversationHistoryTurnV4"
  | "conversationHistoryDirectoryV4"
  | "conversationHistoryContentV4"
  | "onAgentRuntimeRestarted"
> &
  Partial<Pick<IZCodeAgentService, "onAgentRuntimeLifecycle">>;
export interface SubagentHistoryClock {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export interface SubagentHistoryState {
  data?: SubagentConversation;
  error: string | null;
  retry(): Promise<unknown>;
  historyControls?: ConversationHistoryControls;
}
/** Include root and remote identities even though the authorizing service target is the parent. */
export function subagentHistoryScopeKey(scope: SubagentHistoryScope): string {
  return JSON.stringify([
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.remoteSessionId,
    scope.rootSessionId,
    scope.parentSessionId,
    scope.childSessionId,
  ]);
}
