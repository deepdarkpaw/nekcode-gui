import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SubagentSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { useSubagentConversation } from "./useSubagentConversation.js";

/** 标准 ZCode 时间线，数据由父 nek 的只读预览契约提供，不打开一个新的 child 运行时。 */
export function NekSubagentConversation({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  tab: SubagentSessionSidePaneTab;
  focused: boolean;
} & Pick<
  ConversationRowRenderContext,
  "onOpenBrowserUrl" | "onOpenCodeViewer" | "onOpenFileLink"
>) {
  const { zcodeAgentService } = useServices();
  const { intl } = useZCodeIntl();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const load = useCallback(
    () =>
      zcodeAgentService.getSubagentConversation({
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        remoteSessionId: tab.remoteSessionId,
        sessionId: tab.parentSessionId,
        id: tab.childSessionId,
      }),
    [
      zcodeAgentService,
      tab.workspacePath,
      tab.workspaceIdentity,
      tab.remoteSessionId,
      tab.parentSessionId,
      tab.childSessionId,
    ],
  );
  const { data, error, retry } = useSubagentConversation(load, focused);
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
    ],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="nek-subagent-conversation">
      {error ? (
        <div role="alert" className="flex items-center gap-2 p-3 text-ui-sm text-destructive">
          <span className="min-w-0 break-words">{error}</span>
          <Button variant="outline" size="sm" onClick={retry}>
            {intl.formatMessage({ id: "chat.message.bodyPreview.retry" })}
          </Button>
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
          headerSlot={
            data.totalCount > data.rows.length ? (
              <p className="p-3 text-ui-xs text-foreground-subtle">
                {intl.formatMessage(
                  { id: "nek.status.subagent.previewTruncated" },
                  { count: data.totalCount - data.rows.length },
                )}
              </p>
            ) : undefined
          }
        />
      ) : null}
    </div>
  );
}
