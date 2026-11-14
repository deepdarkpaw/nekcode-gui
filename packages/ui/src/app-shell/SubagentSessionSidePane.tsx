import { memo, useCallback, useMemo } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  OpenScopedSubagentSideTabRequest,
  OpenSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  SubagentSessionSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { NekSubagentConversation } from "@/nek/status/NekSubagentConversation.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

export const SubagentSessionSidePane = memo(function SubagentSessionSidePane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  const openChild = useCallback(
    (request: OpenSubagentSideTabRequest) => {
      onOpenSubagentSession({ ...request, ...scope, rootSessionId: tab.rootSessionId });
    },
    [onOpenSubagentSession, scope, tab.rootSessionId],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <NekSubagentConversation
        tab={tab}
        focused={focused}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenSubagentSession={openChild}
      />
    </V4PaneConversationProvider>
  );
});
