import {
  ArrowLeftRightIcon,
  ClockIcon,
  DatabaseIcon,
  ListTodoIcon,
  PlugIcon,
  SearchIcon,
  SquareIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { normalizeZCodeToolName } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

type NekControlIntl = ReturnType<typeof useZCodeIntl>["intl"];
type NekControlInput = Record<string, unknown> | null;

/**
 * nek 控制类工具（计划、模式切换、子代理编排、MCP 资源）在对话流里只需要一行语义摘要。
 * 这些工具的 input 是模型给 runtime 的控制参数，展开渲染只会把原始 JSON 摊回聊天区，
 * 因此这里统一关闭折叠内容，只保留「动作 + 目标 + 失败原因」。
 */
interface NekControlPresentation {
  icon: ReactNode;
  runningLabelId: string;
  completedLabelId: string;
  readPrimaryText: (intl: NekControlIntl, input: NekControlInput) => string | null;
  readSecondaryText?: (intl: NekControlIntl, input: NekControlInput) => string | null;
}

const AWAIT_ICON = <ClockIcon className="size-4 shrink-0 text-foreground-subtle" />;
const STOP_SUBAGENT_ICON = <SquareIcon className="size-3.5 shrink-0 text-foreground-subtle" />;
const PLAN_ICON = <ListTodoIcon className="size-4 shrink-0 text-foreground-subtle" />;
const SWITCH_MODE_ICON = <ArrowLeftRightIcon className="size-4 shrink-0 text-foreground-subtle" />;
const TOOL_SEARCH_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;
const READ_MCP_RESOURCE_ICON = <PlugIcon className="size-4 shrink-0 text-foreground-subtle" />;
const LIST_MCP_RESOURCES_ICON = <DatabaseIcon className="size-4 shrink-0 text-foreground-subtle" />;

const MODE_LABELS: Record<string, string> = { plan: "Plan", agent: "Agent" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(input: NekControlInput, keys: readonly string[]): string | null {
  if (!input) {
    return null;
  }

  for (const key of keys) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

/** MCP 资源的身份由 server + uri 两段拼成，缺任意一段就只显示可得的那一段。 */
function readMcpResourceTarget(input: NekControlInput): string | null {
  const parts = [readField(input, ["server"]), readField(input, ["uri"])].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function readSwitchModeTarget(input: NekControlInput): string | null {
  const targetModeId = readField(input, ["target_mode_id"]);
  if (!targetModeId) {
    return null;
  }
  return MODE_LABELS[targetModeId.toLowerCase()] ?? targetModeId;
}

const NEK_CONTROL_PRESENTATIONS: Record<string, NekControlPresentation> = {
  await: {
    icon: AWAIT_ICON,
    runningLabelId: "chat.toolCall.nekControl.awaiting",
    completedLabelId: "chat.toolCall.nekControl.awaited",
    readPrimaryText: (intl, input) =>
      readField(input, ["subagent_id"]) ??
      intl.formatMessage({ id: "chat.toolCall.nekControl.backgroundSubagents" }),
  },
  stop_subagent: {
    icon: STOP_SUBAGENT_ICON,
    runningLabelId: "chat.toolCall.nekControl.stoppingSubagent",
    completedLabelId: "chat.toolCall.nekControl.stoppedSubagent",
    readPrimaryText: (_intl, input) => readField(input, ["subagent_id"]),
  },
  create_plan: {
    icon: PLAN_ICON,
    runningLabelId: "chat.toolCall.nekControl.draftingPlan",
    completedLabelId: "chat.toolCall.nekControl.draftedPlan",
    readPrimaryText: (_intl, input) => readField(input, ["name", "overview"]),
  },
  update_plan: {
    icon: PLAN_ICON,
    runningLabelId: "chat.toolCall.nekControl.updatingPlan",
    completedLabelId: "chat.toolCall.nekControl.updatedPlan",
    readPrimaryText: (_intl, input) => readField(input, ["explanation"]),
  },
  switch_mode: {
    icon: SWITCH_MODE_ICON,
    runningLabelId: "chat.toolCall.nekControl.switchingMode",
    completedLabelId: "chat.toolCall.nekControl.switchedMode",
    readPrimaryText: (_intl, input) => readSwitchModeTarget(input),
    readSecondaryText: (_intl, input) => readField(input, ["explanation"]),
  },
  tool_search: {
    icon: TOOL_SEARCH_ICON,
    runningLabelId: "chat.toolCall.nekControl.searchingTools",
    completedLabelId: "chat.toolCall.nekControl.searchedTools",
    readPrimaryText: (_intl, input) => readField(input, ["query"]),
  },
  read_mcp_resource: {
    icon: READ_MCP_RESOURCE_ICON,
    runningLabelId: "chat.toolCall.nekControl.readingMcpResource",
    completedLabelId: "chat.toolCall.nekControl.readMcpResource",
    readPrimaryText: (_intl, input) => readMcpResourceTarget(input),
  },
  list_mcp_resources: {
    icon: LIST_MCP_RESOURCES_ICON,
    runningLabelId: "chat.toolCall.nekControl.listingMcpResources",
    completedLabelId: "chat.toolCall.nekControl.listedMcpResources",
    readPrimaryText: (_intl, input) => readMcpResourceTarget(input),
  },
  list_mcp_resource_templates: {
    icon: LIST_MCP_RESOURCES_ICON,
    runningLabelId: "chat.toolCall.nekControl.listingMcpResources",
    completedLabelId: "chat.toolCall.nekControl.listedMcpResources",
    readPrimaryText: (_intl, input) => readMcpResourceTarget(input),
  },
};

// nek 后续新增控制类工具时先落在这里：宁可只剩一行「控制」，
// 也不能退回 fallback 卡把 input 原文摊开。
const NEK_CONTROL_FALLBACK: NekControlPresentation = {
  icon: PLAN_ICON,
  runningLabelId: "chat.toolCall.nekControl.runningGeneric",
  completedLabelId: "chat.toolCall.nekControl.generic",
  readPrimaryText: (_intl, input) => readField(input, ["description", "name", "query", "id"]),
};

function resolveNekControlPresentation(toolName: string | undefined): NekControlPresentation {
  const normalized = normalizeZCodeToolName(toolName);
  const key = normalized ?? toolName?.trim().toLowerCase() ?? "";
  return NEK_CONTROL_PRESENTATIONS[key] ?? NEK_CONTROL_FALLBACK;
}

function toSummaryNode(text: string | null): ReactNode {
  return text ? <span className="min-w-0 truncate">{text}</span> : null;
}

export function NekControlToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const presentation = resolveNekControlPresentation(toolCall.toolName);
  const input = isPlainRecord(toolCall.input) ? toolCall.input : null;
  const kindLabel = intl.formatMessage({
    id: context.isRunning ? presentation.runningLabelId : presentation.completedLabelId,
  });
  const primaryLabel = presentation.readPrimaryText(intl, input);
  const secondaryLabel = presentation.readSecondaryText?.(intl, input) ?? null;
  const primaryText = useMemo(() => toSummaryNode(primaryLabel), [primaryLabel]);
  const secondaryText = useMemo(() => toSummaryNode(secondaryLabel), [secondaryLabel]);
  const isFailed = toolCall.status === "failed";

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={presentation.icon}
        showIcon={context.showIcon !== false}
        // 语义已经全部收敛到摘要行：展开只会重复模型参数，因此不提供任何折叠入口。
        canToggle={false}
        forceOpen={false}
        autoOpen={false}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={secondaryText}
        statusLabel={isFailed ? context.statusLabel : undefined}
        statusTooltip={isFailed ? context.errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title ?? primaryLabel ?? kindLabel}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
