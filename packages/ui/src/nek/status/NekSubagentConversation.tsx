import { useMemo } from "react";
import { AsyncButton } from "@/components/ui/async-button.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SubagentSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { useSubagentHistoryConversation } from "./useSubagentHistoryConversation.js";

/** 标准 ZCode 时间线，数据由父 nek 的只读预览契约提供，不打开一个新的 child 运行时。 */
export function NekSubagentConversation({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
} & Pick<
  ConversationRowRenderContext,
  "onOpenBrowserUrl" | "onOpenCodeViewer" | "onOpenFileLink" | "onOpenSubagentSession"
>) {
  const { zcodeAgentService } = useServices();
  const { intl } = useZCodeIntl();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const { data, error, retry, historyControls } = useSubagentHistoryConversation({
    service: zcodeAgentService,
    scope: tab,
    active: focused,
  });
  const rowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      workspaceRemoteSessionId: tab.remoteSessionId,
      sessionId: tab.childSessionId,
      rootSessionId: tab.rootSessionId,
      theme,
      codePreviewSettings,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      onOpenSubagentSession,
    }),
    [
      tab.workspacePath,
      tab.workspaceIdentity,
      tab.remoteSessionId,
      tab.childSessionId,
      tab.rootSessionId,
      theme,
      codePreviewSettings,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      onOpenSubagentSession,
    ],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="nek-subagent-conversation">
      {error ? (
        <div role="alert" className="flex items-center gap-2 p-3 text-ui-sm text-destructive">
          <span className="min-w-0 break-words">{error}</span>
          <AsyncButton variant="outline" size="sm" onClick={retry} successFeedback="none">
            {intl.formatMessage({ id: "chat.message.bodyPreview.retry" })}
          </AsyncButton>
        </div>
      ) : !data ? (
        <p role="status" className="p-3 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.message.bodyPreview.loading" })}
        </p>
      ) : null}
      {data ? (
        <ConversationTimeline
          sessionKey={`${tab.parentSessionId}:${tab.childSessionId}`}
          rows={data.rows}
          totalCount={data.rows.length}
          rowContext={rowContext}
          sessionPhase={
            data.status === "running"
              ? "running"
              : data.status === "errored"
                ? "error"
                : data.status === "aborted"
                  ? "completedInterrupted"
                  : "completedSuccess"
          }
          historyControls={historyControls}
          canLoadOlder={historyControls?.history.hasOlder ?? false}
          loadingOlder={historyControls?.loading ?? false}
          onLoadOlder={historyControls?.loadOlder}
        />
      ) : null}
    </div>
  );
}
