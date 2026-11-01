// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { SearchToolCallBlock, getSearchPrimaryText } from "./search.js";

vi.mock("../ToolCallBody.js", () => ({
  ToolCallBody: ({ toolCall }: { toolCall: { output?: unknown } }) => (
    <pre>{String(toolCall.output)}</pre>
  ),
}));

const intl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    `${id}:${values?.cwd ?? values?.query ?? ""}`,
};

function context(): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      toolCall: {
        toolId: "ls-test",
        toolName: "ls",
        kind: "search",
        input: { path: "." },
        status: "success",
        output: "README.md",
      },
      childToolCalls: [],
    },
    workspacePath: "/workspace",
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
      showInput: true,
      showOutput: true,
      showKind: true,
    },
  };
}

describe("nek directory listing", () => {
  it("resolves ls by its exact tool identity, not title/kind inference", () => {
    expect(resolveToolCallIdentity({ toolName: "ls", kind: "search" })).toEqual({
      toolName: "ls",
      family: "search",
      source: "toolName",
      isLegacy: false,
    });
  });
  it("describes ls as directory listing rather than a search query", () => {
    expect(getSearchPrimaryText(intl, { path: "." }, "ls")).toBe("chat.toolCall.search.listIn:.");
    expect(getSearchPrimaryText(intl, { pattern: "needle" }, "grep")).toBe(
      "chat.toolCall.search.findWithQuery:needle",
    );
  });
  it("retains the tool name and lets the user expand its real result", () => {
    render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <TooltipProvider>
          <SearchToolCallBlock {...context()} />
        </TooltipProvider>
      </ZCodeIntlProvider>,
    );
    expect(screen.getByText("ls")).toBeTruthy();
    expect(screen.queryByText("README.md")).toBeNull();
    fireEvent.click(screen.getByText("ls"));
    expect(screen.getByText("README.md")).toBeTruthy();
  });
});
