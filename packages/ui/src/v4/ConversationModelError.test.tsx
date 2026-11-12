// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import type {
  ConversationRow,
  TimelineMarkerPayload,
  TimelineMarkerRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationModelError } from "./ConversationModelError.js";
import { buildConversationTurnRenderUnits } from "./conversationTurnRenderUnits.js";

const marker: Extract<TimelineMarkerPayload, { type: "modelError" }> = {
  type: "modelError",
  provider: "CPA",
  model: "gemini-4-carbon",
  api: "google-generative-ai",
  statusCode: 404,
  statusText: "Not Found",
  rawError: '{"error":{"message":"","code":404,"status":"Not Found"}}',
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>{children}</TooltipProvider>
    </ZCodeIntlProvider>
  );
}

afterEach(cleanup);

const rowBase = (rowId: number) => ({
  rowId,
  turnId: "turn:1",
  entityId: `row:${rowId}`,
  createdAt: rowId,
  createdAtSeq: rowId,
});

it("renders a visible 404 model failure and expands selectable raw provider details", () => {
  render(<ConversationModelError marker={marker} />, { wrapper });

  expect(screen.getByText("模型请求失败")).toBeTruthy();
  expect(screen.getByText("CPA/gemini-4-carbon")).toBeTruthy();
  expect(screen.getByText("404 Not Found")).toBeTruthy();
  expect(screen.getByText("请检查该模型的 API 与 Base URL 配置。")).toBeTruthy();
  expect(screen.queryByText(marker.rawError)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /模型请求失败/ }));

  const raw = screen.getByText(marker.rawError);
  expect(raw).toBeTruthy();
  expect(raw.className).toContain("select-text");
});

it("keeps missing provider text visible as a generic failure", () => {
  render(
    <ConversationModelError
      marker={{ type: "modelError", provider: "", model: "", api: "", rawError: "" }}
    />,
    { wrapper },
  );

  expect(screen.getByText("模型请求失败")).toBeTruthy();
  expect(screen.getByText("请求失败")).toBeTruthy();
});

it("keeps model errors in the turn tail path", () => {
  const header: TurnHeaderRow = {
    ...rowBase(1),
    kind: "turnHeader",
    origin: "userInput",
    executionKind: "agent",
    state: "failed",
    startedAt: 1,
    endedAt: 2,
  };
  const user: UserInputRow = {
    ...rowBase(2),
    kind: "userInput",
    text: "prompt",
    origin: "realUser",
  };
  const errorRow: TimelineMarkerRow = {
    ...rowBase(3),
    kind: "timelineMarker",
    lane: "turnTailBoundary",
    marker,
  };
  const unit = buildConversationTurnRenderUnits([header, user, errorRow] as ConversationRow[], {
    sessionPhase: "error",
  })[0];
  expect(unit?.assistantTailRows.map((row) => row.rowId)).toEqual([3]);
});
