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
  | "conversationHistoryDirectoryV4"
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
/** Default timer port defers global lookup so injected/fake clocks remain effective. */
export const SUBAGENT_HISTORY_CLOCK: SubagentHistoryClock = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
/** Trusted routing never substitutes the root/child identity for the authorizing parent. */
export function subagentHistoryTarget(scope: SubagentHistoryScope) {
  return {
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
    remoteSessionId: scope.remoteSessionId,
    sessionId: scope.parentSessionId,
  };
}
export function subagentHistoryReadTarget(scope: SubagentHistoryScope) {
  return { ...subagentHistoryTarget(scope), subagentId: scope.childSessionId };
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
