import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/** Projection-owned seed cache, not a body-history cache: six pages / 1 MB, no completed outputs. */
export class NekHistoryAnchorCache {
  private readonly pages = new Map<
    string,
    { scope: string; rows: ConversationRow[]; bytes: number }
  >();
  private bytes = 0;

  remember(scope: string, key: string, rows: readonly ConversationRow[]): void {
    const anchors = rows.flatMap((row): ConversationRow[] => {
      if (row.kind === "subagent") return [row];
      if (row.kind !== "toolCall") return [];
      const { output: _output, error: _error, ...anchor } = row;
      return [anchor];
    });
    const id = `${scope}\0${key}`;
    const previous = this.pages.get(id);
    if (previous) {
      this.pages.delete(id);
      this.bytes -= previous.bytes;
    }
    const bytes = Buffer.byteLength(JSON.stringify(anchors), "utf8");
    // Oversized seeds remain in the explicit page result; no original content is discarded.
    if (bytes > 1024 * 1024) return;
    this.pages.set(id, { scope, rows: anchors, bytes });
    this.bytes += bytes;
    while (this.pages.size > 6 || this.bytes > 1024 * 1024) {
      const oldest = this.pages.keys().next().value!;
      this.bytes -= this.pages.get(oldest)!.bytes;
      this.pages.delete(oldest);
    }
  }

  read(scope: string): ConversationRow[] {
    const rows = new Map<string | number, ConversationRow>();
    for (const page of this.pages.values())
      if (page.scope === scope)
        for (const row of page.rows) rows.set(row.entityId ?? row.rowId, row);
    return [...rows.values()];
  }

  clear(): void {
    this.pages.clear();
    this.bytes = 0;
  }
}
