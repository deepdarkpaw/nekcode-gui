import type { NekSessionEntry } from "@zcode/shared/nek-protocol";
import type { NekRpcClient } from "../nekRpcClient.js";
import type { NekSessionRecord } from "./types.js";

/** 每页只保留 8 个条目；图片或文件都从 nek 会话事实解析，不积攒整份历史。 */
export async function resolveNekSessionAttachment<T>(
  record: NekSessionRecord,
  find: (entries: readonly NekSessionEntry[]) => T | undefined,
  client: () => NekRpcClient,
  kind: "image" | "file",
): Promise<T> {
  const unknown = () => new Error(`Unknown nek ${kind} attachment ref in session`);
  if (record.readonly) {
    if (!record.snapshot) throw new Error("nek read-only session snapshot is not loaded");
    const attachment = find(record.snapshot.entries as NekSessionEntry[]);
    if (attachment) return attachment;
    throw unknown();
  }
  let beforeEntryId: string | undefined;
  for (;;) {
    const page = await client().call({
      type: "get_entries",
      limit: 8,
      ...(beforeEntryId ? { beforeEntryId } : {}),
    });
    const attachment = find(page.entries);
    if (attachment) return attachment;
    if (!page.hasMore) throw unknown();
    const next = page.entries[0]?.id;
    if (!next || next === beforeEntryId)
      throw new Error("nek attachment lookup page did not advance");
    beforeEntryId = next;
  }
}
