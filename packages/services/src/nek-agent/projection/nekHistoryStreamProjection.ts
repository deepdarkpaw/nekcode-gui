import type {
  NekHistoryPage,
  NekHistoryTurn,
  NekHistoryStreamOmission,
  NekRpcEvent,
  NekAssistantMessage,
} from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { NekLiveContext } from "./nekLiveTurn.js";
import { closeTurn, ensureTurn } from "./nekLiveTurn.js";
import { applyAssistantErrorMarker } from "./nekLiveMessages.js";
import { settleFailedAssistantResponse } from "./nekSettledWork.js";
import { applyCompactionEnd } from "./nekLiveMarkers.js";
import { projectHistory } from "./nekHistoryProjection.js";
import { validateHistoryDisplay } from "./nekHistoryDisplay.js";
import { withNekModelSelection } from "./nekProjectionSnapshot.js";
import { advanceHistorySelection } from "./nekSelectionMarkers.js";
import type { NekHistoryLiveSource } from "./nekHistoryLive.js";

const LIVE_OMISSIONS: Record<string, string[]> = {
  message_start: ["/message"],
  message_end: ["/message"],
  message_update: ["/assistantMessageEvent/content", "/assistantMessageEvent/toolCall"],
  tool_execution_start: ["/args"],
  tool_execution_update: ["/args"],
  tool_execution_end: ["/result/content", "/result/details"],
  turn_end: ["/message", "/toolResults"],
  agent_end: ["/messages"],
  compaction_end: ["/result"],
};

/** Ordered starts and committed facts are paired by delivery order, NEVER timestamp/text equality. */
export class NekHistoryStreamProjection {
  private starts: Array<{ role: string; key: string }> = [];
  private seeds: Array<{ role: "user"; turnId: string } | { role: "assistant"; id: string }> = [];
  private storedResponse = false;
  clear(activeResponse?: string): void {
    this.starts = activeResponse ? [{ role: "assistant", key: activeResponse }] : [];
    this.seeds.length = 0;
    this.storedResponse = false;
  }

  /** Returns true only for events whose exact omissions were handled here. */
  event(
    event: Record<string, unknown>,
    omissions: NekHistoryStreamOmission[],
    key: string,
    ctx: NekLiveContext,
  ): boolean {
    if (
      omissions.some(
        (o) =>
          !LIVE_OMISSIONS[String(event.type)]?.includes(o.pointer) ||
          o.reason !== (event.type === "message_update" ? "redundant_delta" : "persisted_body"),
      )
    )
      throw new Error("unsupported live history omission semantics; update nek and retry history");
    const omitted = new Set(omissions.map((o) => o.pointer));
    const message = event.message as Record<string, unknown> | undefined;
    if (event.type === "message_start" && omitted.has("/message")) {
      if (!message || typeof message.role !== "string")
        throw new Error("invalid metadata-only message_start");
      if (!["user", "assistant"].includes(message.role)) return true;
      const index = this.seeds.findIndex((seed) => seed.role === message.role);
      const seed = index < 0 ? undefined : this.seeds.splice(index, 1)[0];
      if (!seed) {
        if (this.starts.length >= 256)
          throw new Error("history start pairing exceeds 256; reload history");
        this.starts.push({ role: message.role, key });
      }
      if (message.role === "user") {
        // A plan approval can commit the next input *inside* the previous run's settle hook.
        // Only its consumed message_start can transfer the live clock, not its locator.
        closeTurn(ctx, "completedSuccess");
        ctx.nextTurnIdentity = seed?.role === "user" ? seed.turnId : `turn:${key}`;
        ensureTurn(ctx, Number(message.timestamp) || ctx.now());
        return true; // No fabricated empty accepted user message.
      }
      const stored = seed?.role === "assistant" ? seed.id : undefined;
      this.storedResponse = stored !== undefined;
      ctx.assistantResponseKey = stored === undefined ? key : `entry:${stored}`;
      ctx.assistantErrorKey = stored ?? key;
      ctx.assistantModel = `${message.provider}/${message.model}`;
      ensureTurn(ctx, Number(message.timestamp) || ctx.now());
      return true;
    }
    if (event.type === "message_update" && this.storedResponse) return true;
    if (event.type === "message_end" && omitted.has("/message")) {
      if (message?.role === "assistant") {
        if (ctx.turn && typeof message.stopReason === "string")
          ctx.turn.lastStopReason = message.stopReason;
        for (const id of ctx.streamRows.values())
          ctx.store.update(id, (row) =>
            (row.kind === "assistantText" || row.kind === "reasoning") &&
            row.assistantResponseId === ctx.assistantResponseKey
              ? {
                  ...row,
                  state:
                    message.stopReason === "aborted" || message.stopReason === "error"
                      ? "interrupted"
                      : "complete",
                }
              : row,
          );
        settleFailedAssistantResponse(ctx, message.stopReason);
        applyAssistantErrorMarker(ctx, message as unknown as NekAssistantMessage);
        ctx.assistantResponseKey = undefined;
        ctx.assistantErrorKey = undefined;
        this.storedResponse = false;
      }
      return true; // Tool/custom/user bodies are owned by persisted locators.
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as { type: string; contentIndex: number };
      if (omitted.has("/assistantMessageEvent/content")) {
        if (update.type !== "text_end" && update.type !== "thinking_end")
          throw new Error("invalid redundant content omission");
        const id = ctx.streamRows.get(
          `${ctx.assistantResponseKey}:${update.type === "text_end" ? "text" : "thinking"}:${update.contentIndex}`,
        );
        if (id !== undefined)
          ctx.store.update(id, (row) =>
            row.kind === "reasoning" ? { ...row, state: "complete" } : row,
          );
        return true;
      }
      if (omitted.has("/assistantMessageEvent/toolCall")) {
        if (update.type !== "toolcall_end") throw new Error("invalid toolcall omission");
        return true; // Preserve streamed structured arguments/inputText, do not invent {}.
      }
    }
    if (event.type === "compaction_end" && omitted.has("/result")) {
      applyCompactionEnd(
        ctx,
        event as unknown as Extract<NekRpcEvent, { type: "compaction_end" }>,
        true,
      );
      return true;
    }
    if (
      event.type === "tool_execution_end" &&
      (omitted.has("/result/content") || omitted.has("/result/details"))
    ) {
      const id =
        ctx.toolRows.get(String(event.toolCallId)) ??
        ctx.store.findRowId(`tool:${event.toolCallId}`);
      const extras = event.result as Record<string, unknown> | undefined;
      if (id === undefined)
        throw new Error(
          "history tool end has no original tool-call anchor; reload bounded history",
        );
      ctx.store.update(id, (row) =>
        row.kind === "toolCall"
          ? {
              ...row,
              status: event.isError ? "error" : "success",
              endedAt: ctx.now(),
              ...(extras && Object.keys(extras).length ? { liveResult: extras } : {}),
            }
          : row,
      );
      return true;
    }
    return false;
  }

  target(
    source: NekHistoryLiveSource,
    page: NekHistoryPage,
    entryId: string,
    ctx: NekLiveContext,
  ): NekHistoryTurn | undefined {
    const target = page.entries.find((entry) => entry.id === entryId);
    if (!target)
      throw new Error("history locator target missing from bounded around slice; update nek");
    if (target.position < source.nextPosition) return; // Already present in bootstrap/duplicate locator.
    if (target.position !== source.nextPosition || target.parentId !== source.leafId)
      throw new Error(
        `history locator is not contiguous with observed source (target ${target.id}@${target.position} parent ${target.parentId}; observed next ${source.nextPosition} leaf ${source.leafId}); explicitly reload bounded history`,
      );
    const turn = page.turns.find((item) => item.id === target.turnId);
    if (!turn) throw new Error("history target has no owning turn descriptor");
    const role = target.role;
    const aliases = new Map<string, string>();
    let assistantKey: string | undefined;
    if (target.type === "compaction") {
      const compact = ctx.activeCompactEntityId ?? ctx.lastCompletedCompactEntityId;
      if (compact) {
        aliases.set(compact, `entry:${target.id}`);
        if (ctx.activeCompactEntityId) ctx.activeCompactEntityId = `entry:${target.id}`;
        if (ctx.lastCompletedCompactEntityId)
          ctx.lastCompletedCompactEntityId = `entry:${target.id}`;
      }
    }
    if (role === "user" || role === "assistant") {
      const index = this.starts.findIndex((start) => start.role === role);
      const start = index < 0 ? undefined : this.starts.splice(index, 1)[0];
      if (!start) {
        if (this.seeds.length >= 256)
          throw new Error("history persisted pairing exceeds 256; reload history");
        this.seeds.push(role === "user" ? { role, turnId: turn.id } : { role, id: target.id });
      } else if (role === "user") aliases.set(`turn:${start.key}`, turn.id);
      else {
        assistantKey = start.key;
        for (const row of ctx.store.window) {
          if (row.entityId?.startsWith(`${start.key}:`))
            aliases.set(row.entityId, row.entityId.replace(start.key, `entry:${target.id}`));
        }
        aliases.set(`model-error:${start.key}`, `model-error:${target.id}`);
      }
    }
    const oldRows = [...ctx.store.window];
    const projected = projectHistory({
      sessionId: ctx.store.sessionId,
      turns: [turn],
      entries: [target],
      targetEntryId: target.id,
      seed: source.selection,
      anchors: ctx.historyAnchors?.() ?? oldRows,
    });
    if (assistantKey)
      for (const row of projected) {
        if (
          (row.kind === "assistantText" || row.kind === "reasoning") &&
          row.entityId?.startsWith(`entry:${target.id}:`)
        )
          aliases.set(row.entityId.replace(`entry:${target.id}`, assistantKey), row.entityId);
      }
    const canonical = new Map(projected.map((row) => [row.entityId, row]));
    const merged = new Map<string | number, ConversationRow>();
    const replacements = new Map<number, number>();
    for (const old of oldRows) {
      const entity = old.entityId ? (aliases.get(old.entityId) ?? old.entityId) : undefined;
      const persisted = canonical.get(entity);
      const turnId = aliases.get(old.turnId) ?? old.turnId;
      // A target read must not rewind a newer live stream; only matching event identities migrate.
      const row = persisted
        ? {
            ...old,
            rowId: persisted.rowId,
            entityId: persisted.entityId,
            turnId: persisted.turnId,
          }
        : turnId !== old.turnId
          ? { ...old, turnId }
          : old;
      replacements.set(old.rowId, row.rowId);
      merged.set(entity ?? row.rowId, row);
    }
    for (const row of projected) {
      const old = merged.get(row.entityId ?? row.rowId);
      const repeatedHeader =
        row.entityId === turn.id || row.entityId === `entry:${turn.header.id}:user`;
      if (
        old?.kind === "timelineMarker" &&
        old.marker.type === "compact" &&
        row.kind === "timelineMarker" &&
        row.marker.type === "compact"
      )
        merged.set(row.entityId!, {
          ...old,
          marker: { ...row.marker, ...old.marker, summaryRef: row.marker.summaryRef },
        });
      else if (
        !old ||
        (!repeatedHeader &&
          row.kind !== "assistantText" &&
          row.kind !== "reasoning" &&
          !(target.role === "assistant" && row.kind === "toolCall"))
      )
        merged.set(
          row.entityId ?? row.rowId,
          old?.kind === "toolCall" && row.kind === "toolCall" && old.liveResult
            ? { ...row, liveResult: old.liveResult }
            : row,
        );
    }
    for (const map of [ctx.streamRows, ctx.toolRows])
      for (const [key, id] of map) map.set(key, replacements.get(id) ?? id);
    if (ctx.turn) {
      ctx.turn.headerRowId = replacements.get(ctx.turn.headerRowId) ?? ctx.turn.headerRowId;
      ctx.turn.turnId = aliases.get(ctx.turn.turnId) ?? ctx.turn.turnId;
      ctx.turn.entityId = ctx.turn.turnId;
    }
    const rows = [...merged.values()].sort((a, b) => a.rowId - b.rowId);
    const entities = new Map(
      rows.filter((row) => row.entityId).map((row) => [row.entityId!, row.rowId]),
    );
    ctx.store.reconcileRows(
      rows,
      entities,
      Math.max(ctx.store.nextRowIdValue, ...rows.map((row) => row.rowId + 1)),
    );
    for (const [alias, entity] of aliases) source.aliases.set(alias, entity);
    for (const [alias, entity] of source.aliases) {
      if (ctx.store.findRowId(entity) === undefined) source.aliases.delete(alias);
      else ctx.store.bindEntityAlias(alias, entity);
    }
    const entry = validateHistoryDisplay(target.entry);
    if (entry.type === "message" && entry.message.role === "assistant") {
      const assistant = entry.message as NekAssistantMessage;
      settleFailedAssistantResponse(
        ctx,
        assistant.stopReason,
        assistantKey ?? `resp:${assistant.timestamp}`,
      );
    }
    const config = ctx.store.state.config;
    if (entry.type === "model_change" || entry.type === "thinking_level_change")
      ctx.store.setState({
        config: withNekModelSelection(
          entry.type === "model_change"
            ? { ...config, provider: entry.provider, model: entry.modelId }
            : { ...config, thought: entry.thinkingLevel },
        ),
      });
    if (entry.type === "session_info" && typeof entry.name === "string")
      ctx.store.setState({ title: entry.name });
    source.selection = advanceHistorySelection(source.selection, entry);
    source.nextPosition = target.position + 1;
    source.leafId = target.id;
    source.turn = turn;
    return turn;
  }
}
