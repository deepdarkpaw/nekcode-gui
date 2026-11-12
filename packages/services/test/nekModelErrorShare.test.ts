import assert from "node:assert/strict";
import test from "node:test";
import { buildConversationSharePublicProjection } from "../src/conversation-share/conversationSharePublicProjection.js";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

test("public conversation retains model failure status but never copies raw provider response details", () => {
  const base = {
    turnId: "private-turn",
    productTurnId: "private-product",
    createdAt: 1,
    createdAtSeq: 1,
  };
  const rows: ConversationRow[] = [
    { ...base, rowId: 1, kind: "turnHeader", origin: "userInput", state: "failed", startedAt: 1 },
    { ...base, rowId: 2, kind: "userInput", origin: "realUser", text: "hello" },
    {
      ...base,
      rowId: 3,
      kind: "timelineMarker",
      lane: "turnTailBoundary",
      marker: {
        type: "modelError",
        provider: "CPA",
        model: "gemini-4-carbon",
        api: "google-generative-ai",
        statusCode: 404,
        statusText: "PRIVATE echoed backend diagnostic",
        rawError: '{"error":{"apiKey":"PRIVATE","url":"https://private.invalid/"}}',
      },
    },
  ];
  const result = buildConversationSharePublicProjection({
    rows,
    selectedProductTurnIds: ["private-product"],
  });
  const failure = result.rows.find(
    (row) => row.kind === "timelineMarker" && row.marker.type === "modelError",
  );
  assert.ok(failure && failure.kind === "timelineMarker" && failure.marker.type === "modelError");
  assert.equal(failure.marker.statusCode, 404);
  assert.equal(failure.marker.rawError, "");
  assert.equal(failure.marker.statusText, undefined);
  assert.doesNotMatch(JSON.stringify(result.rows), /PRIVATE|private\.invalid/);
  assert.equal(
    (rows[2] as Extract<ConversationRow, { kind: "timelineMarker" }>).marker.type,
    "modelError",
    "private input is untouched",
  );
});
