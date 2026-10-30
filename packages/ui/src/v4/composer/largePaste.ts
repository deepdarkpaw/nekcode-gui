/**
 * 大段粘贴折叠（交互规范 §8「粘贴块折叠」）。
 *
 * 超过阈值的粘贴正文不进编辑器，只插入一行占位标记（`chat.composer.pasteBlock.placeholder`），
 * 发送时再按标记还原原文。块内容只存在于 renderer 内存里的有界按 scope 存储中：
 * 切换会话后切回来仍能还原，但整份草稿不会被大段原文撑爆 localStorage。
 */
export const LARGE_PASTE_CHAR_THRESHOLD = 2_000;
export const LARGE_PASTE_LINE_THRESHOLD = 40;
/** 单个输入框最多折叠 20 段粘贴。 */
export const MAX_LARGE_PASTE_BLOCKS = 20;
/** 单个输入框累计折叠上限 1 MiB，超出后退化为普通粘贴（正文留在编辑器里）。 */
export const MAX_LARGE_PASTE_TOTAL_BYTES = 1024 * 1024;
/** 内存中最多保留 10 个 scope 的折叠块（有界内存，超出淘汰最久未写的）。 */
export const MAX_LARGE_PASTE_SCOPES = 10;

export interface LargePasteBlock {
  readonly id: string;
  readonly marker: string;
  readonly text: string;
  readonly lineCount: number;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function isLargePaste(text: string): boolean {
  return (
    text.length > LARGE_PASTE_CHAR_THRESHOLD || countPasteLines(text) > LARGE_PASTE_LINE_THRESHOLD
  );
}

function countPasteLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length;
}

/** 分配未占用的块 id；同一输入框内 id 稳定，便于删除定位。 */
export function nextLargePasteBlockId(existing: readonly LargePasteBlock[]): string {
  const used = new Set(existing.map((block) => block.id));
  let index = 1;
  while (used.has(`paste-${index}`)) index += 1;
  return `paste-${index}`;
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
  const totalBytes = existing.reduce((total, block) => total + utf8Bytes(block.text), 0);
  if (totalBytes + utf8Bytes(text) > MAX_LARGE_PASTE_TOTAL_BYTES) return null;
  const lineCount = countPasteLines(text);
  return {
    id,
    marker: formatMarker(existing.length + 1, lineCount),
    text,
    lineCount,
  };
}

export function expandLargePasteBlocks(text: string, blocks: readonly LargePasteBlock[]): string {
  return blocks.reduce((expanded, block) => expanded.split(block.marker).join(block.text), text);
}

export function removeLargePasteBlock(
  blocks: readonly LargePasteBlock[],
  id: string,
): LargePasteBlock[] {
  return blocks.filter((block) => block.id !== id);
}

/** 丢弃标记已被用户从正文删掉的块，避免「看不见的块」继续占内存。 */
export function pruneLargePasteBlocks(
  text: string,
  blocks: readonly LargePasteBlock[],
): LargePasteBlock[] {
  return blocks.filter((block) => text.includes(block.marker));
}

// ── 按 draft scope 的内存存储（有界 LRU）────────────────────────────────────
const blocksByScope = new Map<string, readonly LargePasteBlock[]>();

export function readLargePasteBlocks(scopeKey: string): readonly LargePasteBlock[] {
  const blocks = blocksByScope.get(scopeKey);
  if (blocks === undefined) return [];
  // 读取即刷新 LRU 顺序。
  blocksByScope.delete(scopeKey);
  blocksByScope.set(scopeKey, blocks);
  return blocks;
}

export function writeLargePasteBlocks(scopeKey: string, blocks: readonly LargePasteBlock[]): void {
  blocksByScope.delete(scopeKey);
  if (blocks.length > 0) {
    blocksByScope.set(scopeKey, blocks);
  }
  for (const oldestKey of blocksByScope.keys()) {
    if (blocksByScope.size <= MAX_LARGE_PASTE_SCOPES) break;
    blocksByScope.delete(oldestKey);
  }
}

export function resetLargePasteBlocksForTest(): void {
  blocksByScope.clear();
}
