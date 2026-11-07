import { SearchIcon } from "lucide-react";
import { useMemo } from "react";
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import {
  isPlainRecord,
  readStringField,
  type RawToolCallFileSummary,
} from "../fileSummaryTypes.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { renderFileChip } from "../renderers.js";

const READ_GROUP_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * 「读取」摘要只需要文件 chip 的身份：路径是唯一事实，图标与文件名由 display 描述符补齐；
 * actionLabel/operationKind 只是 summary 类型的既有取值，chip 并不渲染它们。
 */
function buildReadFileSummary(path: string): RawToolCallFileSummary {
  const descriptor = resolveFileDisplayDescriptor(path);
  return {
    path,
    actionLabel: "Edited",
    operationKind: "edit",
    fileName: descriptor.fileName,
    filePath: descriptor.filePath,
    fileIconSrc: descriptor.fileIconSrc,
  };
}

/**
 * 同一文件的多次相邻读取聚合：只读展示，不生成 patch、不显示参数 JSON，
 * 也不参与任何增删统计（读取不是写操作）。
 */
export function ReadGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const input = toolCall.input;
  const path = isPlainRecord(input) ? readStringField(input, ["path"]) : undefined;
  const summary = useMemo(() => (path ? buildReadFileSummary(path) : undefined), [path]);
  const countText = intl.formatMessage(
    { id: "chat.toolCall.readGroup.count" },
    { count: String(childToolCalls.length) },
  );
  return (
    <div data-read-group="true">
      <ToolLayout
        toolId={toolCall.toolId}
        icon={READ_GROUP_ICON}
        canToggle={!context.isOfficeMode && (context.canToggle ?? true)}
        forceOpen={!context.isOfficeMode && (context.forceOpen ?? false)}
        kindLabel={intl.formatMessage({ id: "chat.toolCall.readGroup.label" })}
        primaryText={
          summary
            ? renderFileChip({ summary, basePath: context.workspacePath })
            : (toolCall.title ?? countText)
        }
        secondaryText={<span className="text-ui-sm text-foreground-subtlest">{countText}</span>}
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        renderContent={() => (
          <div className="ml-2 space-y-2 border-l border-border pl-3.5">
            {childToolCalls.map((child) => (
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
