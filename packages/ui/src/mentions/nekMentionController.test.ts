import { describe, expect, it } from "vitest";
import {
  createNekMentionState,
  reduceNekMention,
  resolveNekMentionKey,
} from "./nekMentionController.js";

describe("nek mention controller logic", () => {
  it("MN-K1/MN-K2/MN-K3/MN-K6: wraps navigation, accepts, dismisses, and ignores IME", () => {
    expect(resolveNekMentionKey({ key: "ArrowDown", candidateCount: 2, selected: 0 })).toBe("next");
    expect(resolveNekMentionKey({ key: "ArrowUp", candidateCount: 2, selected: 0 })).toBe(
      "previous",
    );
    expect(resolveNekMentionKey({ key: "Enter", candidateCount: 2, selected: 0 })).toBe("accept");
    expect(resolveNekMentionKey({ key: "Tab", candidateCount: 0, selected: -1 })).toBeNull();
    expect(resolveNekMentionKey({ key: "Escape", candidateCount: 2, selected: 0 })).toBe("dismiss");
    expect(
      resolveNekMentionKey({ key: "Enter", candidateCount: 2, selected: 0, isComposing: true }),
    ).toBeNull();
    expect(
      resolveNekMentionKey({ key: "Escape", candidateCount: 2, selected: 0, keyCode: 229 }),
    ).toBeNull();
  });

  it("MN-K3: dismissal is sticky until the query changes", () => {
    let state = createNekMentionState();
    state = reduceNekMention(state, { type: "query", query: "agent:" });
    state = reduceNekMention(state, { type: "dismiss" });
    expect(state.open).toBe(false);
    state = reduceNekMention(state, { type: "query", query: "agent:" });
    expect(state.open).toBe(false);
    state = reduceNekMention(state, { type: "query", query: "agent:e" });
    expect(state.open).toBe(true);
  });

  it("MN-K4/MN-K5: hover/click selection stays within candidate bounds", () => {
    let state = createNekMentionState();
    state = reduceNekMention(state, { type: "query", query: "" });
    state = reduceNekMention(state, {
      type: "loaded",
      query: "",
      candidates: [{ kind: "agent", name: "a", label: "agent:a", insertText: "@agent:a " }],
    });
    expect(reduceNekMention(state, { type: "highlight", index: 0 }).selected).toBe(0);
    expect(reduceNekMention(state, { type: "highlight", index: 3 })).toBe(state);
  });
});
