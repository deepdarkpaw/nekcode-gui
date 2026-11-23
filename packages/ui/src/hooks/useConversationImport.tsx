import { createContext, useContext } from "react";

export interface TaskArchiveTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

interface ConversationImportAction {
  available: boolean;
  canExport: boolean;
  busy: boolean;
  open: (from?: TaskArchiveTarget, isCurrent?: () => boolean) => boolean;
  exportTask: (from: TaskArchiveTarget, taskId: string, isCurrent?: () => boolean) => boolean;
}
const ConversationImportContext = createContext<ConversationImportAction | null>(null);
export const ConversationImportProvider = ConversationImportContext.Provider;
export function useConversationImport(): ConversationImportAction | null {
  return useContext(ConversationImportContext);
}
