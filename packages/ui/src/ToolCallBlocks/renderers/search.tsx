import { SearchIcon } from "lucide-react";
import { useMemo } from "react";
import { normalizeZCodeToolName } from "@zcode/shared";
import { ToolCallBody } from "../ToolCallBody.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import type { ToolDisplayModel, ToolInlinePreview } from "@/lib/toolDisplay.js";

const SEARCH_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * AST 搜索的主文本就是结构化查询本身，不再是 "查找 {query}" 句式：
 * 摘要行已经用「AST 搜索」标明动作，再包一层模板会重复动词。
 */
function getAstSearchPrimaryText(input: unknown): string | null {
  if (!isPlainRecord(input)) {
    return null;
  }

  for (const key of ["pattern", "path", "lang"] as const) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function getSearchKindLabel(
  intl: IntlLike,
  state: { isAstSearch: boolean; isDirectoryListing: boolean; isRunning: boolean },
): string {
  if (state.isDirectoryListing) {
    return "ls";
  }
  if (state.isAstSearch) {
    return intl.formatMessage({
      id: state.isRunning
        ? "chat.toolCall.search.searchingAst"
        : "chat.toolCall.search.searchedAst",
    });
  }
  return intl.formatMessage({
    id: state.isRunning ? "chat.toolCall.search.searching" : "chat.toolCall.kind.search",
  });
}

export function getSearchPrimaryText(intl: IntlLike, input: unknown, toolName?: string): string {
  if (normalizeZCodeToolName(toolName) === "ls") {
    const path = isPlainRecord(input) && typeof input.path === "string" ? input.path.trim() : "";
    return path
      ? intl.formatMessage({ id: "chat.toolCall.search.listIn" }, { cwd: path })
      : intl.formatMessage({ id: "chat.toolCall.search.list" });
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed.length > 0
      ? intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: trimmed })
      : intl.formatMessage({ id: "chat.toolCall.search.find" });
  }

  if (!isPlainRecord(input)) {
    return intl.formatMessage({ id: "chat.toolCall.search.find" });
  }

  const parsedCmd = input.parsed_cmd;
  if (Array.isArray(parsedCmd)) {
    for (const item of parsedCmd) {
      if (!isPlainRecord(item) || typeof item.type !== "string") {
        continue;
      }

      if (item.type === "list_files") {
        const cwd =
          typeof input.cwd === "string" && input.cwd.trim().length > 0
            ? input.cwd.trim().replace(/\/+$/, "")
            : undefined;
        return cwd
          ? intl.formatMessage({ id: "chat.toolCall.search.listIn" }, { cwd })
          : intl.formatMessage({ id: "chat.toolCall.search.list" });
      }

      if (item.type === "search" || item.type === "grep" || item.type === "glob") {
        const candidate =
          typeof item.pattern === "string"
            ? item.pattern.trim()
            : typeof item.query === "string"
              ? item.query.trim()
              : typeof item.path === "string"
                ? item.path.trim()
                : "";
        return candidate.length > 0
          ? intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: candidate })
          : intl.formatMessage({ id: "chat.toolCall.search.find" });
      }
    }
  }

  for (const key of [
    "search_query",
    "searchQuery",
    "query",
    "pattern",
    "path",
    // WebFetch 同时带 url 和 prompt 时，权限/工具摘要展示 prompt 会遮住真正需要用户确认的目标地址。
    "url",
    "prompt",
    "target",
    "name",
  ] as const) {
    const candidate = input[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return intl.formatMessage({ id: "chat.toolCall.search.findWithQuery" }, { query: trimmed });
    }
  }

  return intl.formatMessage({ id: "chat.toolCall.search.find" });
}

/**
 * web_search 交给模型的输出本来就是 Markdown（编号来源列表 + 摘要），
 * 直接按 Markdown 渲染才能点开来源；结构化输出仍走通用 Result，不做二次猜测。
 */
function webSearchMarkdown(output: unknown): string | null {
  return typeof output === "string" && output.trim().length > 0 ? output : null;
}

/** 正文已经是结果本身，通用 Parameters/Result 只会把同一段内容再摊一遍。 */
function webSearchDisplayModel(model: ToolDisplayModel): ToolDisplayModel {
  return { ...model, showInput: false, showOutput: false };
}

function webSearchInlinePreview(output: string, title: string): ToolInlinePreview {
  return {
    type: "text",
    source: { type: "text", title, content: output, language: "markdown" },
  };
}

export function SearchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const normalizedToolName = normalizeZCodeToolName(toolCall.toolName);
  const isDirectoryListing = normalizedToolName === "ls";
  const isWebSearch = normalizedToolName === "web_search";
  const webOutput = isWebSearch ? webSearchMarkdown(toolCall.output) : null;
  const hasContent = isDirectoryListing || webOutput !== null;
  const isAstSearch = normalizedToolName === "ast_grep";
  const searchPrimaryText = isAstSearch
    ? getAstSearchPrimaryText(toolCall.input)
    : getSearchPrimaryText(intl, toolCall.input, toolCall.toolName);
  const primaryText = useMemo(
    () => (searchPrimaryText ? <span className="truncate">{searchPrimaryText}</span> : null),
    [searchPrimaryText],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEARCH_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasContent}
        kindLabel={
          context.kindLabelOverride ??
          getSearchKindLabel(intl, { isAstSearch, isDirectoryListing, isRunning })
        }
        sourceLabel={context.sourceLabel}
        // search 的主文本直接拼成一句完整摘要，不再拆 secondaryText；
        // 这样能避免 title 干扰，也更适合列表/目录查询这类操作。
        primaryText={primaryText}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={
          hasContent
            ? () => (
                <ToolCallBody
                  toolCall={toolCall}
                  displayModel={
                    webOutput ? webSearchDisplayModel(context.displayModel) : context.displayModel
                  }
                  inlinePreviewOverride={
                    webOutput
                      ? webSearchInlinePreview(webOutput, toolCall.toolName ?? "web_search")
                      : undefined
                  }
                  childToolList={isWebSearch ? null : context.childToolList}
                  workspacePath={context.workspacePath}
                  theme={context.theme}
                  codePreviewSettings={context.codePreviewSettings}
                  onOpenCodeViewer={context.onOpenCodeViewer}
                  onOpenFileLink={context.onOpenFileLink}
                  onOpenBrowserUrl={context.onOpenBrowserUrl}
                />
              )
            : undefined
        }
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
      {/* <pre>{JSON.stringify(toolCall, null, 2)}</pre> */}
    </>
  );
}
