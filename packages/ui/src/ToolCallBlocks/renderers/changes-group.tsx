import { PencilIcon } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { buildFileChangeGroup } from "../fileChangeGroup.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { renderDiffCount, renderFileChip } from "../renderers.js";

const CHANGES_GROUP_ICON = <PencilIcon className="size-4 shrink-0 text-foreground-subtle" />;

/** Consecutive edits have one file header; expanding it goes directly to the original calls. */
export function ChangesGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const { files } = useMemo(
    () => buildFileChangeGroup(childToolCalls, context.workspacePath),
    [childToolCalls, context.workspacePath],
  );
  return (
    <div data-changes-group="true">
      {files.map((file) => (
        <div key={file.key} data-change-file={file.key}>
          <ToolLayout
            toolId={files.length === 1 ? toolCall.toolId : `${toolCall.toolId}:file:${file.key}`}
            icon={CHANGES_GROUP_ICON}
            canToggle={!context.isOfficeMode && (context.canToggle ?? true)}
            forceOpen={!context.isOfficeMode && (context.forceOpen ?? false)}
            kindLabel={intl.formatMessage({ id: "chat.toolCall.changesGroup.label" })}
            primaryText={
              file.summary
                ? renderFileChip({ summary: file.summary, basePath: context.workspacePath })
                : intl.formatMessage({ id: "chat.toolCall.changesGroup.receivingPath" })
            }
            diffCount={context.isOfficeMode ? undefined : renderDiffCount(file.stats)}
            isRunning={file.stats.running > 0}
            statusLabel={
              file.stats.failed > 0
                ? intl.formatMessage({ id: "chat.toolCall.status.failed" })
                : file.stats.cancelled > 0
                  ? intl.formatMessage({ id: "chat.toolCall.status.stopped" })
                  : undefined
            }
            showStatusLabel={file.stats.failed > 0 || file.stats.cancelled > 0}
            showFailureStatus={file.stats.failed > 0}
            title={file.summary?.path}
            renderContent={() => (
              <div className="ml-2 space-y-2 border-l border-border pl-3.5">
                {file.calls.map((child) => (
                  <ToolCallBlock
                    key={child.toolCall.toolId}
                    toolCallNode={child}
                    workspacePath={context.workspacePath}
                    theme={context.theme}
                    codePreviewSettings={context.codePreviewSettings}
                    showIcon={false}
                    onOpenCodeViewer={context.onOpenCodeViewer}
                    onOpenFileLink={context.onOpenFileLink}
                    onOpenBrowserUrl={context.onOpenBrowserUrl}
                    onLoadFullToolCallFields={context.onLoadFullToolCallFields}
                  />
                ))}
              </div>
            )}
          />
        </div>
      ))}
    </div>
  );
}
