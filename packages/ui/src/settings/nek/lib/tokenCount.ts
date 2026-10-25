/**
 * tokens 数量输入：支持 `200k`、`1M`、`1.5k`、`128,000`、`128000`（1k = 1000）。
 */

const TOKEN_PATTERN = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/;

/** 解析输入；非法或非正整数结果返回 null。 */
export function parseTokenCount(draft: string): number | null {
  const text = draft.trim().replace(/[,_\s]/g, "");
  const match = TOKEN_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const base = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "k" ? 1000 : unit === "m" ? 1_000_000 : 1;
  const value = Math.round(base * multiplier);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** 输入框里的展示形式：整 M / 整 k 用缩写，其余原样。 */
export function formatTokenCountDraft(value: number | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (value % 1_000_000 === 0) {
    return `${value / 1_000_000}M`;
  }
  if (value % 1000 === 0) {
    return `${value / 1000}k`;
  }
  return String(value);
}
