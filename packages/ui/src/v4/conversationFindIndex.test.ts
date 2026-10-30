import { describe, expect, it } from "vitest";
import {
  buildConversationFindIndex,
  CONVERSATION_FIND_MAX_MATCHES,
} from "./conversationFindIndex.js";
import type { ConversationTurnRenderUnit } from "./conversationTurnRenderUnits.js";

function unit(text: string): ConversationTurnRenderUnit {
  return {
    key: "unit-1",
    turnId: "turn-1",
    visibleUserInputs: [
      {
        kind: "userInput",
        rowId: 1,
        turnId: "turn-1",
        createdAt: 0,
        createdAtSeq: 1,
        text,
        origin: "realUser",
      },
    ],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: [],
    renderRows: [],
    isLastTurn: true,
    isRunning: false,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
  };
}

describe("conversation find index", () => {
  it("S1: matches case-insensitively and caps retained matches", () => {
    const index = buildConversationFindIndex([unit("A ".repeat(10_000))], "a");
    expect(index.matchCount).toBe(CONVERSATION_FIND_MAX_MATCHES);
    expect(index.matches).toHaveLength(CONVERSATION_FIND_MAX_MATCHES);
  });
});
