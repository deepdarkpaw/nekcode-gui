// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";

afterEach(cleanup);

/**
 * nek 侧全部工具名：builtin 工具 + 子代理/控制类工具。
 * 少登记一个就会退回 unknown → fallback 卡，把原始参数 JSON 摊进聊天区。
 */
const NEK_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "web_search",
  "subagent",
  "create_plan",
  "update_plan",
  "switch_mode",
  "await",
  "stop_subagent",
  "tool_search",
  "read_mcp_resource",
  "list_mcp_resources",
  "list_mcp_resource_templates",
] as const;

function toolCall(toolName: string, overrides: Partial<TaskChatToolCall> = {}): TaskChatToolCall {
  return {
    toolId: `tool-${toolName}`,
    toolName,
    kind: toolName,
    status: "completed",
    input: {},
    ...overrides,
  };
}

function renderContext(toolCallValue: TaskChatToolCall): ToolCallBlockRenderContext {
  return {
    toolCallNode: { toolCall: toolCallValue, childToolCalls: [] },
    workspacePath: "G:/project",
    isRunning: false,
    statusLabel: "完成",
    childToolList: null,
    rawFileSummaries: [],
    viewerSource: null,
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
  };
}

function show(toolCallValue: TaskChatToolCall) {
  return render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ToolCallBlock
          toolCallNode={{ toolCall: toolCallValue, childToolCalls: [] }}
          workspacePath="G:/project"
        />
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

describe("nek tool identity coverage", () => {
  it.each([...NEK_TOOL_NAMES])(
    "resolves %s to a known family with a dedicated renderer",
    (toolName) => {
      const identity = resolveToolCallIdentity({ toolName, kind: toolName });

      expect(identity.family).not.toBe("unknown");
      expect(resolveToolCallRenderer(renderContext(toolCall(toolName)))).not.toBe(
        FallbackToolCallBlock,
      );
    },
  );

  it("keeps plan tools out of the file-write and todo families", () => {
    for (const toolName of ["create_plan", "update_plan"]) {
      const identity = resolveToolCallIdentity({ toolName, kind: toolName });

      expect(identity.family).not.toBe("file-write");
      expect(identity.family).not.toBe("todo");
    }
  });

  it("keeps the nek plan preview row on the ZCode plan card", () => {
    const identity = resolveToolCallIdentity({ toolName: "nek.plan", kind: "nek.plan" });

    expect(identity).toEqual({
      toolName: "nek.plan",
      family: "switch-mode",
      source: "toolName",
      isLegacy: false,
    });
  });
});

interface PresentationCase {
  toolName: string;
  input: Record<string, unknown>;
  runningLabel: string;
  completedLabel: string;
  primaryText: string;
  /** 原始参数片段：只要出现在 DOM 文本里，就说明卡片又把 JSON 参数摊开了。 */
  rawParameterFragment: string;
}

const PRESENTATION_CASES: PresentationCase[] = [
  {
    toolName: "create_plan",
    input: { name: "NekLASCA", plan: "# NekLASCA\n1. inspect" },
    runningLabel: "正在制定计划",
    completedLabel: "制定计划",
    primaryText: "NekLASCA",
    rawParameterFragment: "# NekLASCA",
  },
  {
    toolName: "update_plan",
    input: { explanation: "补齐渲染器守卫", plan: "# NekLASCA\n2. guard" },
    runningLabel: "正在更新计划",
    completedLabel: "更新计划",
    primaryText: "补齐渲染器守卫",
    rawParameterFragment: "# NekLASCA",
  },
  {
    toolName: "switch_mode",
    input: { target_mode_id: "plan", explanation: "先定稿计划" },
    runningLabel: "正在切换模式",
    completedLabel: "切换模式",
    primaryText: "Plan",
    rawParameterFragment: "target_mode_id",
  },
  {
    toolName: "await",
    input: { subagent_id: "sub-42" },
    runningLabel: "正在等待子代理",
    completedLabel: "等待子代理",
    primaryText: "sub-42",
    rawParameterFragment: "subagent_id",
  },
  {
    toolName: "stop_subagent",
    input: { subagent_id: "sub-7" },
    runningLabel: "正在停止子代理",
    completedLabel: "停止子代理",
    primaryText: "sub-7",
    rawParameterFragment: "subagent_id",
  },
  {
    toolName: "subagent",
    input: {
      description: "审查渲染器",
      prompt: "你是审查者，逐个检查 nek 工具卡的渲染结果。",
      subagent_type: "general-purpose",
    },
    runningLabel: "子智能体",
    completedLabel: "子智能体",
    primaryText: "审查渲染器",
    rawParameterFragment: "你是审查者",
  },
  {
    toolName: "tool_search",
    input: { query: "mcp resource" },
    runningLabel: "正在搜索工具",
    completedLabel: "搜索工具",
    primaryText: "mcp resource",
    rawParameterFragment: "query",
  },
  {
    toolName: "ast_grep",
    input: { pattern: "console.log($$$ARGS)", path: "packages/ui/src", lang: "tsx" },
    runningLabel: "正在搜索 AST",
    completedLabel: "AST 搜索",
    primaryText: "console.log($$$ARGS)",
    rawParameterFragment: "packages/ui/src",
  },
];

describe("nek tool presentation", () => {
  it.each(PRESENTATION_CASES)(
    "renders $toolName as a single semantic line while running",
    ({ toolName, input, runningLabel, primaryText, rawParameterFragment }) => {
      const { container } = show(toolCall(toolName, { status: "pending", input }));

      expect(screen.getByText(runningLabel)).toBeTruthy();
      expect(screen.getByText(primaryText)).toBeTruthy();
      expectRenderedWithoutRawParameters(container, rawParameterFragment);
    },
  );

  it.each(PRESENTATION_CASES)(
    "renders $toolName as a single semantic line once finished",
    ({ toolName, input, completedLabel, primaryText, rawParameterFragment }) => {
      const { container } = show(toolCall(toolName, { status: "completed", input }));

      expect(screen.getByText(completedLabel)).toBeTruthy();
      expect(screen.getByText(primaryText)).toBeTruthy();
      expectRenderedWithoutRawParameters(container, rawParameterFragment);
    },
  );

  it("labels background waits without an explicit subagent id", () => {
    show(toolCall("await", { status: "completed", input: {} }));

    expect(screen.getByText("等待子代理")).toBeTruthy();
    expect(screen.getByText("后台子代理")).toBeTruthy();
  });

  it("shows the MCP resource target on one line", () => {
    show(
      toolCall("read_mcp_resource", {
        status: "completed",
        input: { server: "playwright", uri: "file:///tmp/shot.png" },
      }),
    );

    expect(screen.getByText("读取 MCP 资源")).toBeTruthy();
    expect(screen.getByText("playwright · file:///tmp/shot.png")).toBeTruthy();
  });

  it("keeps failure details in the status tooltip instead of raw parameters", () => {
    const { container } = show(
      toolCall("create_plan", {
        status: "failed",
        input: { name: "NekLASCA", plan: "# NekLASCA" },
        error: "nek rejected create_plan",
      }),
    );

    expect(screen.getByText("执行失败")).toBeTruthy();
    expect(container.textContent).not.toContain("nek rejected create_plan");
    expectRenderedWithoutRawParameters(container, "# NekLASCA");
  });
});

function expectRenderedWithoutRawParameters(container: HTMLElement, rawParameterFragment: string) {
  const text = container.textContent ?? "";

  expect(text).not.toMatch(/parameters/iu);
  expect(text).not.toContain(rawParameterFragment);
  // 单行摘要：既没有折叠触发器，也没有 aria-expanded 的展开态。
  expect(container.querySelector("[aria-expanded]")).toBeNull();
  expect(screen.queryByRole("button", { name: "展开工具详情" })).toBeNull();
}
