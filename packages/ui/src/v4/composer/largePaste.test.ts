import { describe, expect, it } from "vitest";
import {
  createLargePasteBlock,
  expandLargePasteBlocks,
  LARGE_PASTE_CHAR_THRESHOLD,
  LARGE_PASTE_LINE_THRESHOLD,
  removeLargePasteBlock,
} from "./largePaste.js";

describe("large paste blocks", () => {
  it("P1: folds a paste over either configured threshold into a visible marker", () => {
    const byChars = createLargePasteBlock({
      id: "paste-1",
      text: "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 1),
      existing: [],
      formatMarker: (index, lines) => `[paste ${index}, ${lines} lines]`,
    });
    const byLines = createLargePasteBlock({
      id: "paste-2",
      text: Array.from({ length: LARGE_PASTE_LINE_THRESHOLD + 1 }, () => "x").join("\n"),
      existing: [],
      formatMarker: (index, lines) => `[paste ${index}, ${lines} lines]`,
    });
    expect(byChars?.marker).toContain("paste 1");
    expect(byLines?.lineCount).toBe(LARGE_PASTE_LINE_THRESHOLD + 1);
  });

  it("P2: expands only known markers at send time", () => {
    const text = "original\ncontent".repeat(200);
    const block = createLargePasteBlock({
      id: "paste-1",
      text,
      existing: [],
      formatMarker: () => "[paste 1]",
    });
    expect(block).not.toBeNull();
    expect(expandLargePasteBlocks("before [paste 1] after", block ? [block] : [])).toBe(
      `before ${text} after`,
    );
    expect(expandLargePasteBlocks("[paste 2]", block ? [block] : [])).toBe("[paste 2]");
  });

  it("P3: deleting a block removes its expansion source without mutating other blocks", () => {
    const first = {
      id: "paste-1",
      marker: "[paste 1]",
      text: "first",
      lineCount: 1,
    } as const;
    const second = {
      id: "paste-2",
      marker: "[paste 2]",
      text: "second",
      lineCount: 1,
    } as const;
    expect(removeLargePasteBlock([first, second], "paste-1")).toEqual([second]);
    expect(expandLargePasteBlocks("[paste 1] [paste 2]", [second])).toBe(
      "[paste 1] second",
    );
  });
});
