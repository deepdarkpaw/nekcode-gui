export const LARGE_PASTE_CHAR_THRESHOLD = 2_000;
export const LARGE_PASTE_LINE_THRESHOLD = 40;
export const MAX_LARGE_PASTE_BLOCKS = 20;
export const MAX_LARGE_PASTE_TOTAL_BYTES = 4 * 1024 * 1024;

export interface LargePasteBlock {
  readonly id: string;
  readonly marker: string;
  readonly text: string;
  readonly lineCount: number;
}

export function isLargePaste(text: string): boolean {
  return (
    text.length > LARGE_PASTE_CHAR_THRESHOLD ||
    countPasteLines(text) > LARGE_PASTE_LINE_THRESHOLD
  );
}

export function countPasteLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length;
}

export function createLargePasteBlock({
  id,
  text,
  existing,
  formatMarker,
}: {
  id: string;
  text: string;
  existing: readonly LargePasteBlock[];
  formatMarker: (index: number, lineCount: number) => string;
}): LargePasteBlock | null {
  if (!isLargePaste(text)) return null;
  if (existing.length >= MAX_LARGE_PASTE_BLOCKS) return null;
  const totalBytes = existing.reduce(
    (total, block) => total + new TextEncoder().encode(block.text).byteLength,
    0,
  );
  if (totalBytes + new TextEncoder().encode(text).byteLength > MAX_LARGE_PASTE_TOTAL_BYTES) {
    return null;
  }
  const lineCount = countPasteLines(text);
  return {
    id,
    marker: formatMarker(existing.length + 1, lineCount),
    text,
    lineCount,
  };
}

export function expandLargePasteBlocks(
  text: string,
  blocks: readonly LargePasteBlock[],
): string {
  return blocks.reduce(
    (expanded, block) => expanded.split(block.marker).join(block.text),
    text,
  );
}

export function removeLargePasteBlock(
  blocks: readonly LargePasteBlock[],
  id: string,
): LargePasteBlock[] {
  return blocks.filter((block) => block.id !== id);
}
