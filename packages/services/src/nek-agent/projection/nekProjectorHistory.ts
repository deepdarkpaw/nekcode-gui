import { NekHistoryStreamProjection } from "./nekHistoryStreamProjection.js";
import type { NekHistorySummaryPage, NekHistoryStreamOmission } from "@zcode/shared/nek-protocol";
import { NekHistoryAnchorCache } from "./nekHistoryAnchorCache.js";
import { randomUUID } from "node:crypto";
import type {
  NekHistoryPage,
  NekHistoryMetadata,
  NekRpcSessionState,
  NekSessionStats,
  NekState,
  NekRpcEvent,
} from "@zcode/shared/nek-protocol";
import type { ConversationHistory, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { NekProjectionStore } from "./nekProjectionStore.js";
import { createNekLiveContext, type NekLiveContext } from "./nekLiveTurn.js";
import {
  historyLiveSource,
  mergeStreamingHistory,
  rebindStreamingHistory,
  reconcileHistoryAppend,
  type NekHistoryLiveSource,
} from "./nekHistoryLive.js";
import { historyMetadata, projectHistory } from "./nekHistoryProjection.js";
import { preserveObservedTiming } from "./nekObservedTiming.js";
import { buildConfigState, buildControlState, planFromNekState } from "./nekProjectionSnapshot.js";
import { boundHistoryResult } from "../service/nekHistoryRpc.js";

export interface NekHistorySnapshotInput {
  page: NekHistoryPage;
  metadata: NekHistoryMetadata;
  state?: NekRpcSessionState;
  stats?: NekSessionStats;
  nekState?: NekState;
}

/** Part of the projector owner: bounded current header + metadata, never all source entries. */
export class NekProjectorHistory {
  readonly anchors = new NekHistoryAnchorCache();
  metadata: ConversationHistory | undefined;
  private source: NekHistoryLiveSource | undefined;
  private readonly pendingUserStarts = new Set<string>();
  private readonly stream = new NekHistoryStreamProjection();

  historyAnchors(store: NekProjectionStore, scope = store.sessionId): ConversationRow[] {
    return [
      ...this.anchors.read(scope),
      ...(scope === store.sessionId
        ? store.window.filter((row) => row.kind === "toolCall" || row.kind === "subagent")
        : []),
    ];
  }

  createLiveContext(store: NekProjectionStore, now: () => number): NekLiveContext {
    const live = createNekLiveContext(store, now);
    live.historyPages = this.metadata !== undefined;
    live.historyAnchors = () => this.historyAnchors(store);
    return live;
  }

  applyStreamEvent(
    event: Record<string, unknown>,
    omissions: NekHistoryStreamOmission[],
    key: string,
    ctx: NekLiveContext,
  ): boolean {
    return this.stream.event(event, omissions, key, ctx);
  }

  applyTarget(page: NekHistoryPage, entryId: string, ctx: NekLiveContext): void {
    if (!this.source) throw new Error("history source is not bootstrapped");
    this.stream.target(this.source, page, entryId, ctx);
  }

  applySummary(page: NekHistorySummaryPage, store: NekProjectionStore): boolean {
    if (!this.source || page.totalEntries > this.source.nextPosition) return false;
    if (page.totalEntries !== this.source.nextPosition || page.leafId !== this.source.leafId)
      throw new Error("history summary source moved backwards or changed branch; reload history");
    this.metadata = historyMetadata(page);
    store.setHistory(this.metadata);
    return true;
  }

  load(store: NekProjectionStore, input: NekHistorySnapshotInput, live?: NekLiveContext): void {
    const { page, metadata, state, stats, nekState } = input;
    if (!live) this.stream.clear();
    const previousRows = [...store.window];
    const compatible = this.accepts(page);
    const previousAliases = compatible ? this.source?.aliases : undefined;
    let rows = projectHistory({
      sessionId: store.sessionId,
      turns: page.turns,
      entries: page.entries,
      seed: page.seed,
      nekState,
      anchors: compatible
        ? [
            ...this.anchors.read(store.sessionId),
            ...store.window.filter((row) => row.kind === "subagent"),
          ]
        : [],
    });
    boundHistoryResult(rows);
    if (rows.length > store.windowRowLimit)
      throw new Error("nek history projected row limit exceeded; request a smaller source page");
    if (live) rows = mergeStreamingHistory(rows, live);
    const lastHeader = rows.findLast((row) => row.kind === "turnHeader");
    if (lastHeader?.kind === "turnHeader" && state?.isStreaming) {
      rows = rows.map((row) =>
        row === lastHeader ? { ...lastHeader, state: "running", endedAt: undefined } : row,
      );
    }
    const byEntity = new Map(
      rows.filter((row) => row.entityId).map((row) => [row.entityId!, row.rowId]),
    );
    store.replaceRows(
      preserveObservedTiming(rows, store.window),
      byEntity,
      Math.max(1, ...rows.map((row) => row.rowId + 1)),
    );
    if (!compatible) {
      store.rotateLogEpoch(`nek-history:${randomUUID()}`);
      this.anchors.clear();
      this.pendingUserStarts.clear();
    }
    this.anchors.remember(
      store.sessionId,
      `${page.branchRevision}:${page.entries[0]?.position}:${page.entries.at(-1)?.position}`,
      rows,
    );
    this.metadata = historyMetadata(page);
    this.source = historyLiveSource(page);
    if (live) rebindStreamingHistory(live, previousRows);
    for (const [alias, entity] of previousAliases ?? [])
      if (store.findRowId(entity) !== undefined) {
        this.source.aliases.set(alias, entity);
        store.bindEntityAlias(alias, entity);
      }
    const retainedUsers = new Set(this.source.aliases.values());
    for (const id of this.pendingUserStarts)
      if (!retainedUsers.has(id)) this.pendingUserStarts.delete(id);
    const selection = metadata.selection;
    store.setState({
      title: state?.sessionName ?? metadata.session.name ?? "",
      config: buildConfigState(
        state,
        state?.model?.provider ?? selection.model?.provider ?? "",
        state?.model?.id ?? selection.model?.modelId ?? "",
        state?.thinkingLevel ?? selection.thinkingLevel ?? "",
        nekState?.mode ?? store.state.config.mode,
      ),
      usage: {
        contextWindow: stats?.contextUsage
          ? {
              usedTokens: stats.contextUsage.tokens ?? 0,
              maxTokens: stats.contextUsage.contextWindow,
              autoCompactThresholdTokens: null,
            }
          : null,
        cumulative: {
          inputTokens: metadata.usage.input,
          outputTokens: metadata.usage.output,
          cacheReadTokens: metadata.usage.cacheRead,
          cacheWriteTokens: metadata.usage.cacheWrite,
        },
      },
      plan: nekState ? planFromNekState(nekState) : store.state.plan,
      control: buildControlState(state, state?.isStreaming ? "running" : "completedSuccess"),
    });
  }

  /** Non-cursor pages must prove compatibility with the currently observed persisted tail. */
  accepts(page: NekHistoryPage): boolean {
    if (!this.source || this.metadata?.branchRevision === page.branchRevision) return true;
    if (page.leafId === this.source.leafId)
      return this.source.nextPosition > this.source.baseEntries;
    return page.entries.some((entry) => entry.id === this.source!.leafId);
  }

  get observedEntries(): number | undefined {
    return this.source?.nextPosition;
  }

  resetStreamSeeds(activeResponse?: string): void {
    this.stream.clear(activeResponse);
    this.pendingUserStarts.clear();
    this.source?.aliases.clear();
  }

  resetProcessSeeds(): void {
    this.stream.clear();
    this.anchors.clear();
    this.pendingUserStarts.clear();
    this.source?.aliases.clear();
  }

  /** Legacy synthetic entry tests share the same incremental canonical owner. */
  apply(event: NekRpcEvent, ctx: NekLiveContext): "changed" | "duplicate" | undefined {
    if (!this.metadata) return;
    if (Buffer.byteLength(JSON.stringify(event), "utf8") > 1024 * 1024)
      throw new Error(
        "nek live history event exceeds 1 MB; CLI bounded live content refs are required (historyPages does not cover live frames)",
      );
    const message = event.type === "message_start" ? event.message : undefined;
    if (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "user" &&
      "timestamp" in message
    ) {
      const key = `msg:${message.timestamp}:user`;
      const canonical = this.source?.aliases.get(key);
      const ready = canonical && this.pendingUserStarts.delete(canonical);
      if (!ready && (canonical || ctx.store.findRowId(key) !== undefined))
        throw new Error(
          "nek live message identity is ambiguous (duplicate timestamp); CLI stable live entry identities are required",
        );
    }
    if (event.type !== "entry_appended" || !this.source) return;
    if (event.entry.id === this.source.leafId) return "duplicate";
    if (event.entry.type !== "message") {
      if (event.entry.parentId !== this.source.leafId)
        throw new Error("nek history branch changed; bounded snapshot rebuild required");
      this.source.nextPosition += 1;
      this.source.leafId = event.entry.id;
      return;
    }
    if (event.entry.message.role === "user") {
      const liveId = ctx.store.findRowId(`msg:${event.entry.message.timestamp}:user`);
      const started =
        liveId !== undefined && ctx.store.getRow(liveId)?.entityId?.startsWith("msg:");
      if (!started) {
        if (this.pendingUserStarts.size >= 4096)
          throw new Error("nek pending live identity seed limit exceeded");
        this.pendingUserStarts.add(`entry:${event.entry.id}:user`);
      }
    }
    const rows = reconcileHistoryAppend(this.source, event.entry, ctx);
    const entities = new Map(
      rows.filter((row) => row.entityId).map((row) => [row.entityId!, row.rowId]),
    );
    ctx.store.reconcileRows(
      rows,
      entities,
      Math.max(ctx.store.nextRowIdValue, ...rows.map((row) => row.rowId + 1)),
    );
    for (const [alias, entity] of this.source.aliases) ctx.store.bindEntityAlias(alias, entity);
    if (event.entry.message.role === "user") {
      this.metadata = {
        ...this.metadata,
        totalTurns: this.metadata.totalTurns + 1,
        turns: [
          ...this.metadata.turns,
          {
            turnId: `turn:${event.entry.id}`,
            userEntryId: event.entry.id,
            position: this.source.nextPosition - 1,
            preview:
              typeof event.entry.message.content === "string"
                ? event.entry.message.content.slice(0, 256)
                : "",
          },
        ].slice(-20),
      };
    }
    ctx.store.setHistory(this.metadata);
    return "changed";
  }
}
