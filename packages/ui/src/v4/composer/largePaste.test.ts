import { afterEach, describe, expect, it } from "vitest";
import {
  createLargePasteBlock,
  expandLargePasteBlocks,
  LARGE_PASTE_CHAR_THRESHOLD,
  LARGE_PASTE_LINE_THRESHOLD,
  MAX_LARGE_PASTE_BLOCKS,
  MAX_LARGE_PASTE_SCOPES,
  MAX_LARGE_PASTE_TOTAL_BYTES,
  nextLargePasteBlockId,
  pruneLargePasteBlocks,
  readLargePasteBlocks,
  removeLargePasteBlock,
  resetLargePasteBlocksForTest,
  writeLargePasteBlocks,
} from "./largePaste.js";

const block = (
  id: string,
  marker: string,
  text = "x",
): {
  id: string;
  marker: string;
  text: string;
  lineCount: number;
} => ({ id, marker, text, lineCount: 1 });

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

  afterEach(() => resetLargePasteBlocksForTest());

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
    expect(expandLargePasteBlocks("[paste 1] [paste 2]", [second])).toBe("[paste 1] second");
  });

  it("P10: stops folding once the block count or byte budget is exhausted", () => {
    const full = Array.from({ length: MAX_LARGE_PASTE_BLOCKS }, (_, index) =>
      block(`paste-${index}`, `[paste ${index}]`),
    );
    expect(
      createLargePasteBlock({
        id: "paste-x",
        text: "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 1),
        existing: full,
        formatMarker: () => "[paste x]",
      }),
    ).toBeNull();
    const big = block("paste-1", "[paste 1]", "x".repeat(MAX_LARGE_PASTE_TOTAL_BYTES));
    expect(
      createLargePasteBlock({
        id: "paste-2",
        text: "y".repeat(LARGE_PASTE_CHAR_THRESHOLD + 1),
        existing: [big],
        formatMarker: () => "[paste 2]",
      }),
    ).toBeNull();
  });

  it("P11: markers deleted from the text drop their blocks, kept markers survive", () => {
    const blocks = [block("paste-1", "[paste 1]"), block("paste-2", "[paste 2]")];
    expect(pruneLargePasteBlocks("keep [paste 2] only", blocks)).toEqual([blocks[1]]);
    expect(pruneLargePasteBlocks("[paste 1] [paste 2]", blocks)).toEqual(blocks);
  });

  it("P12: block ids stay unique inside one composer", () => {
    expect(nextLargePasteBlockId([])).toBe("paste-1");
    expect(nextLargePasteBlockId([block("paste-1", "[a]"), block("paste-3", "[b]")])).toBe(
      "paste-2",
    );
  });

  it("P13: per-scope storage keeps blocks across session switches and stays bounded", () => {
    writeLargePasteBlocks("scope-a", [block("paste-1", "[paste 1]")]);
    expect(readLargePasteBlocks("scope-a")).toHaveLength(1);
    for (let index = 0; index <= MAX_LARGE_PASTE_SCOPES; index += 1) {
      writeLargePasteBlocks(`scope-${index}`, [block("paste-1", "[paste 1]")]);
    }
    expect(readLargePasteBlocks("scope-a")).toHaveLength(0);
    writeLargePasteBlocks(`scope-${MAX_LARGE_PASTE_SCOPES}`, []);
    expect(readLargePasteBlocks(`scope-${MAX_LARGE_PASTE_SCOPES}`)).toHaveLength(0);
  });
});
