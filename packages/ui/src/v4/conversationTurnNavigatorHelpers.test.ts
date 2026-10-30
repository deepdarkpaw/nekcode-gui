import { describe, expect, it } from "vitest";
import { resolveAdjacentConversationTurnQuery } from "./conversationTurnNavigatorHelpers.js";

describe("conversation turn keyboard navigation", () => {
  const targets = [
    { unitIndex: 0, rowId: 10 },
    { unitIndex: 1, rowId: 20 },
    { unitIndex: 2, rowId: 30 },
  ];

  it("N1: Ctrl+Up moves to the previous real-user query", () => {
    expect(resolveAdjacentConversationTurnQuery(targets, 20, "previous")).toEqual(targets[0]);
  });

  it("N2: Ctrl+Down moves to the next real-user query and clamps at the end", () => {
    expect(resolveAdjacentConversationTurnQuery(targets, 20, "next")).toEqual(targets[2]);
    expect(resolveAdjacentConversationTurnQuery(targets, 30, "next")).toEqual(targets[2]);
  });

  it("N3: navigation starts at the first or last query when no row is active", () => {
    expect(resolveAdjacentConversationTurnQuery(targets, undefined, "next")).toEqual(targets[0]);
    expect(resolveAdjacentConversationTurnQuery(targets, undefined, "previous")).toEqual(
      targets[2],
    );
  });
});
