import { describe, expect, it } from "vitest";
import {
  appendPromptHistoryEntry,
  MAX_PROMPT_HISTORY_ENTRY_BYTES,
  navigatePromptHistory,
} from "./promptHistory.js";

describe("prompt history", () => {
  it("P4: caps entries and bytes while preserving chronological order", () => {
    const huge = "中".repeat(MAX_PROMPT_HISTORY_ENTRY_BYTES);
    const entries = appendPromptHistoryEntry(["one"], huge, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toBe("one");
    expect(new TextEncoder().encode(entries[1]).byteLength).toBeLessThanOrEqual(
      MAX_PROMPT_HISTORY_ENTRY_BYTES,
    );
  });

  it("P5: up browses older entries and down returns to the draft after the newest entry", () => {
    expect(navigatePromptHistory(["one", "two"], null, "up")).toEqual({
      nextIndex: 1,
      nextValue: "two",
      shouldHandle: true,
    });
    expect(navigatePromptHistory(["one", "two"], 1, "down")).toEqual({
      nextIndex: null,
      nextValue: "",
      shouldHandle: true,
    });
  });

  it("P6: down from a fresh empty editor is not intercepted", () => {
    expect(navigatePromptHistory(["one"], null, "down")).toEqual({
      nextIndex: null,
      nextValue: "",
      shouldHandle: false,
    });
  });
});
