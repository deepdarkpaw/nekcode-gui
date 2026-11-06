// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { NekAssistantMessage, NekAssistantMessageEvent } from "@zcode/shared/nek-protocol";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../../../services/src/nek-agent/nekConversationProjector.js";
import { toolCallRowToLegacyNode } from "./toolCallRowAdapter.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/shared.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const assistant = {
  role: "assistant",
  api: "openai-completions",
  content: [],
  timestamp: 1000,
  provider: "mock",
  model: "test",
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
} as NekAssistantMessage;
afterEach(cleanup);

function setup() {
  const p = new NekConversationProjector({ sessionId: "s", schedule: () => () => undefined });
  p.handleEvent({ type: "message_start", message: assistant });
  const emit = (assistantMessageEvent: NekAssistantMessageEvent) => {
    p.handleEvent({ type: "message_update", assistantMessageEvent, usage: assistant.usage });
    p.flushNow();
  };
  emit({ type: "toolcall_start", contentIndex: 0, id: "write-1", toolName: "write" });
  const row = () => p.rows.window.find((row) => row.kind === "toolCall") as ToolCallRow;
  const summary = () => {
    const call = toolCallRowToLegacyNode(row()).toolCall;
    return readRawToolCallFileSummaries(call.raw, call)[0]!;
  };
  return { p, emit, row, summary };
}

function view(row: ToolCallRow) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ToolCallBlock toolCallNode={toolCallRowToLegacyNode(row)} workspacePath="G:/project" />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

it("W1/W2: durable field deltas grow filename, diff and line count before tool completion", () => {
  const { p, emit, row, summary } = setup();
  try {
    emit({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"G:","content":"# Arch"}',
      arguments: { path: "G:", content: "# Arch" },
    });
    const ui = render(view(row()));
    expect(summary().changeStat?.added).toBe(1);
    emit({
      type: "toolcall_delta",
      contentIndex: 0,
      argumentPath: ["path"],
      delta: "/project/ARD.md",
    });
    emit({
      type: "toolcall_delta",
      contentIndex: 0,
      argumentPath: ["content"],
      delta: "\nfirst\nsecond\n",
    });
    ui.rerender(view(row()));
    expect(row().status).toBe("inputStreaming");
    expect(summary().path).toBe("G:/project/ARD.md");
    expect(summary().changeStat?.added).toBe(3);
    expect(summary().patch).toContain("second");
    expect(screen.getByText("ARD.md")).toBeTruthy();
    expect(toolCallRowToLegacyNode(row()).toolCall.raw).toMatchObject({
      inputPreviewComplete: false,
    });
    emit({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"G:/project/ARD.md","content":"replacement"}',
      arguments: { path: "G:/project/ARD.md", content: "replacement" },
    });
    expect(summary().changeStat?.added).toBe(1);
    expect(summary().patch).not.toContain("second");
  } finally {
    p.dispose();
  }
});

it("W3: a recovery partial snapshot updates the existing tool and accepts later field deltas", () => {
  const { p, emit, row, summary } = setup();
  try {
    emit({
      type: "start",
      message: {
        ...assistant,
        content: [
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "G:/project/ARD.md", content: "one" },
          },
        ],
      },
    });
    emit({
      type: "toolcall_delta",
      contentIndex: 0,
      argumentPath: ["content"],
      delta: "\ntwo\nthree",
    });
    expect(summary().changeStat?.added).toBe(3);
    expect(p.rows.window.filter((row) => row.kind === "toolCall")).toHaveLength(1);
    expect(row().status).toBe("inputStreaming");
  } finally {
    p.dispose();
  }
});

it("W4: native raw-JSON tool deltas still accumulate without being interpreted as field deltas", () => {
  const { p, emit, summary } = setup();
  try {
    emit({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"path":"G:/project/ARD.md","content":"one',
    });
    emit({ type: "toolcall_delta", contentIndex: 0, delta: '\\ntwo\\nthree"}' });
    expect(summary().path).toBe("G:/project/ARD.md");
    expect(summary().changeStat?.added).toBe(3);
  } finally {
    p.dispose();
  }
});
