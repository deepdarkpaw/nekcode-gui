import {
  applyConversationDeltas,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/** Frame-local identity admission, not another accepted body store. */
function canonicalAppends(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationDelta[] {
  const byId = new Map(snapshot.rows.window.map((row) => [row.rowId, row]));
  const byEntity = new Map(
    snapshot.rows.window.flatMap((row) =>
      row.entityId ? [[row.entityId, row.rowId] as const] : [],
    ),
  );
  const result: ConversationDelta[] = [];
  const remove = (id: number) => {
    const old = byId.get(id);
    if (old?.entityId && byEntity.get(old.entityId) === id) byEntity.delete(old.entityId);
    byId.delete(id);
  };
  const admit = (row: ConversationRow) => {
    const alias = row.entityId ? byEntity.get(row.entityId) : undefined;
    if (alias !== undefined && alias !== row.rowId) {
      result.push({ op: "rows.removed", rowIds: [alias] });
      remove(alias);
    }
    const present = byId.has(row.rowId);
    remove(row.rowId);
    byId.set(row.rowId, row);
    if (row.entityId) byEntity.set(row.entityId, row.rowId);
    return present;
  };
  for (const delta of deltas) {
    if (delta.op === "row.appended") {
      result.push({ op: admit(delta.row) ? "row.upserted" : "row.appended", row: delta.row });
      continue;
    }
    if (delta.op === "row.upserted" && byId.has(delta.row.rowId)) admit(delta.row);
    if (delta.op === "rows.removed") for (const id of delta.rowIds) remove(id);
    if (delta.op === "row.removed")
      for (const id of byId.keys()) if (id >= delta.fromRowId) remove(id);
    result.push(delta);
  }
  return result;
}

/** Preserve shared delta semantics, except boundary-only history is consumed by the window owner. */
export function applyConversationLiveDeltas(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  const bodyDeltas = deltas.map((delta): ConversationDelta => {
    if (delta.op !== "state.updated" || !delta.patch.history) return delta;
    const { history: _boundary, ...patch } = delta.patch;
    return { op: "state.updated", patch };
  });
  // Streaming token frames keep the existing bounded batch reducer fast path (no full identity index).
  return applyConversationDeltas(
    snapshot,
    bodyDeltas.some((d) => d.op === "row.appended" || d.op === "row.upserted")
      ? canonicalAppends(snapshot, bodyDeltas)
      : bodyDeltas,
  );
}
