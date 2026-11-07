import { PencilIcon } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import {
  buildFileChangeGroup,
  type ChangeFileGroup,
  type ChangeGroupStats,
} from "../fileChangeGroup.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { renderDiffCount, renderFileChip } from "../renderers.js";

const CHANGES_GROUP_ICON = <PencilIcon className="size-4 shrink-0 text-foreground-subtle" />;

function ChangeStatus({ stats }: { stats: ChangeGroupStats }) {
  const { intl } = useZCodeIntl();
  const labels = [
    ["completed", stats.completed],
    ["running", stats.running],
    ["failed", stats.failed],
    ["cancelled", stats.cancelled],
  ] as const;
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-ui-sm">
      {labels
        .filter(([, count]) => count > 0)
        .map(([kind, count]) => (
          <span
            key={kind}
            className={kind === "failed" ? "text-destructive" : "text-foreground-subtlest"}
          >
            {intl.formatMessage(
              { id: `chat.toolCall.changesGroup.${kind}` },
              { count: String(count) },
            )}
          </span>
        ))}
      {stats.unknown > 0 ? (
        <span>{intl.formatMessage({ id: "chat.toolCall.changesGroup.unknownStats" })}</span>
      ) : null}
    </span>
  );
}

function ChangeFile({
  file,
  context,
}: {
  file: ChangeFileGroup;
  context: ToolCallBlockRenderContext;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div data-change-file={file.key}>
      <ToolLayout
        toolId={`${context.toolCallNode.toolCall.toolId}:file:${file.key}`}
        icon={CHANGES_GROUP_ICON}
        showIcon={false}
        kindLabel={null}
        primaryText={
          file.summary
            ? renderFileChip({ summary: file.summary, basePath: context.workspacePath })
            : intl.formatMessage({ id: "chat.toolCall.changesGroup.receivingPath" })
        }
        secondaryText={<ChangeStatus stats={file.stats} />}
        diffCount={renderDiffCount(file.stats)}
        isRunning={file.stats.running > 0}
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
  );
}

/** Presentation-only grouping: the canonical tool rows, order and results remain untouched. */
export function ChangesGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const { files, totals } = useMemo(
    () => buildFileChangeGroup(childToolCalls, context.workspacePath),
    [childToolCalls, context.workspacePath],
  );
  const resolvedCount = files.filter((file) => file.summary).length;
  const countText = intl.formatMessage(
    {
      id:
        resolvedCount > 0
          ? resolvedCount === 1
            ? "chat.toolCall.changesGroup.file.one"
            : "chat.toolCall.changesGroup.file.other"
          : files.length === 1
            ? "chat.toolCall.changesGroup.tool.one"
            : "chat.toolCall.changesGroup.tool.other",
    },
    { count: String(resolvedCount || files.length) },
  );
  const only = files.length === 1 ? files[0]?.summary : undefined;
  return (
    <div data-changes-group="true">
      <ToolLayout
        toolId={toolCall.toolId}
        icon={CHANGES_GROUP_ICON}
        canToggle={!context.isOfficeMode && (context.canToggle ?? true)}
        forceOpen={!context.isOfficeMode && (context.forceOpen ?? false)}
        kindLabel={intl.formatMessage({ id: "chat.toolCall.changesGroup.label" })}
        primaryText={
          only ? renderFileChip({ summary: only, basePath: context.workspacePath }) : countText
        }
        secondaryText={<ChangeStatus stats={totals} />}
        expandedPrimaryText={countText}
        diffCount={context.isOfficeMode ? undefined : renderDiffCount(totals)}
        isRunning={totals.running > 0}
        renderContent={() => (
          <div className="ml-2 space-y-2 border-l border-border pl-3.5">
            {files.map((file) => (
              <ChangeFile key={file.key} file={file} context={context} />
            ))}
          </div>
        )}
      />
    </div>
  );
}
