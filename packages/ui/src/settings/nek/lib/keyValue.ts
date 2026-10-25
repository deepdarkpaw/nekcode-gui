/**
 * 键值对编辑（请求头、环境变量）：行列表 ↔ 对象。
 */

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

let rowSeq = 0;

export function createKeyValueRow(key = "", value = ""): KeyValueRow {
  rowSeq += 1;
  return { id: `kv-${rowSeq}`, key, value };
}

export function rowsFromRecord(
  record: Readonly<Record<string, string>> | undefined,
): KeyValueRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => createKeyValueRow(key, value));
}

/** 空键行忽略；空结果返回 undefined（不写入该字段）。 */
export function recordFromRows(rows: readonly KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value] as const)
    .filter(([key]) => key !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** 重复的键（第二次及之后出现的行 id）。 */
export function duplicateKeyRowIds(rows: readonly KeyValueRow[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") {
      continue;
    }
    if (seen.has(key)) {
      duplicates.add(row.id);
    }
    seen.add(key);
  }
  return duplicates;
}
