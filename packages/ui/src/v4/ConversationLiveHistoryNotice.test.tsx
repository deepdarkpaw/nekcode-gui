// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationLiveHistoryNotice } from "./ConversationLiveHistoryNotice.js";
import { ConversationLiveToolResults } from "./ConversationLiveToolResults.js";

afterEach(cleanup);
const raw = '<img src="bad" onerror="alert(1)"> [unsafe](javascript:alert(1))';

it("LR5: incomplete raw transport stays collapsed/plain and reload waits without resending input", async () => {
  const gate = Promise.withResolvers<void>();
  const reload = vi.fn(() => gate.promise);
  const { container } = render(
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <ConversationLiveHistoryNotice
          preview={{
            epoch: "epoch",
            eventId: 1,
            eventType: "message_update",
            preview: raw,
            receivedBytes: 1_048_576,
            incomplete: true,
          }}
          error="TRANSIENT_LIMIT"
          reload={reload}
        />
      </ZCodeIntlProvider>
    </TooltipProvider>,
  );
  expect(screen.getByRole("alert").textContent).toContain("不会重发消息");
  expect(container.querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /不完整的原始片段/ }));
  expect((await screen.findByText(raw)).tagName).toBe("PRE");
  expect(container.querySelector("img, a")).toBeNull();
  const button = screen.getByRole("button", { name: "重新读取历史" });
  fireEvent.click(button);
  expect(reload).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  await act(async () => gate.resolve());
  await waitFor(() => expect(button.getAttribute("aria-busy")).not.toBe("true"));
});

it("LR5: stream failures without a preview remain retryable and errors stay visible", async () => {
  render(
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <ConversationLiveHistoryNotice
          error="SEQUENCE_GAP"
          reload={async () => {
            throw new Error("RECOVERY_ACTIVE");
          }}
        />
      </ZCodeIntlProvider>
    </TooltipProvider>,
  );
  expect(screen.queryByText("SEQUENCE_GAP")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新读取历史" }));
  expect((await screen.findByRole("tooltip")).textContent).toContain("当前回合仍在运行");
  fireEvent.click(screen.getByRole("button", { name: "错误详情" }));
  expect((await screen.findByText("SEQUENCE_GAP")).tagName).toBe("PRE");
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

it("LR5: tool extras are explicitly expanded without replacing the stored tool output", async () => {
  const row: ToolCallRow = {
    kind: "toolCall",
    rowId: 9,
    turnId: "turn:1",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "call",
    toolName: "mcp_fixture",
    inputText: "{}",
    status: "success",
    output: { text: "stored output" },
    liveResult: { structuredContent: raw, terminate: true },
  };
  const { container } = render(
    <TooltipProvider>
      <ZCodeIntlProvider initialLocale="zh-CN">
        <ConversationLiveToolResults rows={[row]} scopeKey="fixture-live-extras" />
      </ZCodeIntlProvider>
    </TooltipProvider>,
  );
  expect(container.querySelector("pre")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "实时工具附加数据（1 项）" }));
  await waitFor(() =>
    expect(container.querySelector("pre")?.textContent).toBe(JSON.stringify(row.liveResult)),
  );
  expect(container.querySelector("img, a")).toBeNull();
  expect(row.output?.text).toBe("stored output");
  expect(screen.getByText(/可能未写入会话历史/)).toBeTruthy();
});
