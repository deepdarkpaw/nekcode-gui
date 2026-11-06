import type {
  ConversationSnapshot,
  ConversationTopicFrame,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  NekRpcEvent,
  NekRpcSessionState,
  NekSessionStats,
  NekState,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import type { NekBashResult } from "@zcode/shared/nek-protocol";
import type { NekSnapshotInput } from "./projection/nekEntryProjection.js";
import { projectEntries } from "./projection/nekEntryProjection.js";
import { preserveObservedTiming } from "./projection/nekObservedTiming.js";
import {
  buildControlState,
  planFromNekState,
  withNekMode,
} from "./projection/nekProjectionSnapshot.js";
import { NekProjectionStore } from "./projection/nekProjectionStore.js";
import { NekExtensionErrors } from "./projection/nekExtensionErrors.js";
import type { NekLiveContext } from "./projection/nekLiveProjection.js";
import {
  applyBashCommandResultRow,
  applyNekLiveEvent,
  applySessionState,
  applySubagentRecord,
  createNekLiveContext,
} from "./projection/nekLiveProjection.js";

/**
 * nek → ZCodium v4 对话投影器。
 *
 * 两个入口：
 * - `loadSnapshot({ entries, messages, state, ... })`：重新读取会话（首屏、重连、外部改写）后重建行，
 *   并下发**完整快照帧**（`fromSeq: 0`）；
 * - `handleEvent(event)`：把 nek 的 RPC 事件流并入投影，按 v4 增量规则（`row.appended` /
 *   `row.upserted` / `row.delta`）合并后下发**增量帧**（`fromSeq === 上一帧 toSeq`）。
 *
 * 流式文本按 `streamFlushIntervalMs`（默认 50 ms，即每秒最多 20 次）合并刷新，
 * 保证一帧里带多个 `row.delta` 而不是每条 token 一帧。
 *
 * 订阅者收到的 `ConversationTopicFrame` 可直接喂给
 * `packages/ui/src/v4/conversationProjectionStore.ts` 的 `handleFrame`。
 */

export type NekConversationFrameScheduler = (run: () => void, delayMs: number) => () => void;

export interface NekConversationProjectorOptions {
  sessionId: string;
  /** 订阅代际；缺省用 `nek:<sessionId>:1`。重新订阅要换新值（客户端据此丢弃迟到帧）。 */
  subscriptionId?: string;
  logEpoch?: string;
  /** 缺省 `conversation/<sessionId>`。 */
  topic?: string;
  now?: () => number;
  schedule?: NekConversationFrameScheduler;
  /** 流式合并窗口，默认 50 ms。 */
  streamFlushIntervalMs?: number;
  maxWindowRows?: number;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

const DEFAULT_STREAM_FLUSH_INTERVAL_MS = 50;

function defaultScheduler(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class NekConversationProjector {
  readonly topic: string;
  private readonly subscriptionId: string;
  private readonly now: () => number;
  private readonly schedule: NekConversationFrameScheduler;
  private readonly streamFlushIntervalMs: number;
  private readonly logger: NekConversationProjectorOptions["logger"];
  private readonly listeners = new Set<(frame: ConversationTopicFrame) => void>();
  private store: NekProjectionStore;
  private live: NekLiveContext;
  private readonly extensionErrors = new NekExtensionErrors();
  private seq = 0;
  private revisionValue = 0;
  private cancelFlush: (() => void) | undefined;
  private lastFlushAt = 0;
  private disposed = false;

  constructor(options: NekConversationProjectorOptions) {
    this.topic = options.topic ?? `conversation/${options.sessionId}`;
    this.subscriptionId = options.subscriptionId ?? `nek:${options.sessionId}:1`;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultScheduler;
    this.streamFlushIntervalMs = options.streamFlushIntervalMs ?? DEFAULT_STREAM_FLUSH_INTERVAL_MS;
    this.logger = options.logger;
    this.store = new NekProjectionStore({
      sessionId: options.sessionId,
      logEpoch: options.logEpoch ?? "nek-1",
      maxWindowRows: options.maxWindowRows,
      initialState: {
        title: "",
        config: {
          provider: "",
          model: "",
          thought: "",
          thoughtLevels: [],
          followupMode: "queue",
          mode: "agent",
        },
        usage: {
          contextWindow: null,
          cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
        plan: null,
        control: buildControlState(undefined, "running"),
        queue: { items: [], autoDrain: true },
      },
    });
    this.live = createNekLiveContext(this.store, this.now);
  }

  get sessionId(): string {
    return this.store.sessionId;
  }

  get seqValue(): number {
    return this.seq;
  }

  get revision(): number {
    return this.revisionValue;
  }

  get rows(): ConversationSnapshot["rows"] {
    return this.store.snapshot(this.seq, this.revisionValue).rows;
  }

  /**
   * 订阅帧。订阅即刻收到一份完整快照（协议要求：`resume` 之外一律先给 snapshot），
   * 之后是增量帧。返回退订函数。
   */
  subscribe(listener: (frame: ConversationTopicFrame) => void): () => void {
    this.listeners.add(listener);
    this.emitSnapshot(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 重新读取会话并下发快照（首屏、重连、或 entries 视角发生变化时）。 */
  loadSnapshot(input: Omit<NekSnapshotInput, "sessionId">): void {
    const projected = projectEntries({
      ...input,
      sessionId: this.store.sessionId,
      // 每次权威快照都从条目重建，避免 live 事件身份与持久化 entry 身份不一致时
      // 把旧 rowId 带入新快照，导致 resume 后同一会话出现不同 rowId。
      existing: undefined,
    });
    projected.rows = preserveObservedTiming(projected.rows, this.store.window);
    this.store.replaceRows(projected.rows, projected.byEntity, projected.nextRowId);
    this.extensionErrors.project(this.store, projected.rows.at(-1)?.turnId ?? "turn-0");
    this.store.state = {
      ...this.store.state,
      title: projected.title || this.store.state.title,
      config: withNekMode(
        {
          ...projected.config,
          mode: this.store.state.config.mode,
          planTransition: this.store.state.config.planTransition,
        },
        projected.config.mode,
      ),
      usage: projected.usage,
      plan: projected.plan ?? this.store.state.plan,
      control: buildControlState(input.state, this.store.state.control.phase),
    };
    this.live = createNekLiveContext(this.store, this.now);
    // 快照本身就包含全部行，所以不再额外发增量帧。
    this.emitSnapshotToAll();
  }

  /** 并入一条 RPC 事件；有变化时按合并窗口下发增量帧。 */
  handleEvent(event: NekRpcEvent): void {
    if (this.disposed) return;
    if (event.type === "extension_error") {
      this.extensionErrors.record(event, this.now());
      this.extensionErrors.project(this.store, this.live.turn?.turnId ?? "turn-0");
    } else applyNekLiveEvent(this.live, event);
    this.scheduleFlush();
  }

  /** 合并 `get_state` / `get_session_stats` 的结果（含上下文窗口用量）。 */
  applySessionState(state: NekRpcSessionState, stats?: NekSessionStats): void {
    applySessionState(this.live, state);
    this.store.state.control = buildControlState(state, this.store.state.control.phase);
    // 窗口大小只能从 nek 报告里取：`get_session_stats.contextUsage` 优先，其次模型元数据。
    const maxTokens = stats?.contextUsage?.contextWindow ?? state.model?.contextWindow;
    if (maxTokens !== undefined && maxTokens > 0) {
      this.store.state.usage = {
        ...this.store.state.usage,
        contextWindow: {
          usedTokens:
            stats?.contextUsage?.tokens ?? this.store.state.usage.contextWindow?.usedTokens ?? 0,
          maxTokens,
          autoCompactThresholdTokens: null,
        },
      };
    }
    this.scheduleFlush();
  }

  /** `extension_event: nek.state` 的完整快照。 */
  applyNekState(state: NekState): void {
    this.store.state.config = withNekMode(this.store.state.config, state.mode);
    this.store.state.plan = planFromNekState(state) ?? this.store.state.plan;
    this.scheduleFlush();
  }

  /** `extension_event: nek.subagent` 的增量。 */
  applySubagent(record: NekSubagentRecord, parentToolCallId?: string): void {
    applySubagentRecord(this.live, record, parentToolCallId);
    this.scheduleFlush();
  }

  /** 直接 `bash` 命令的最终结果（`bash_execution_update` 已经流出了输出）。 */
  applyBashCommandResult(requestId: string, command: string, result: NekBashResult): void {
    applyBashCommandResultRow(this.live, requestId, command, result);
    this.scheduleFlush();
  }

  /** 立刻把待发增量下发（测试与"用户要求马上看到"的场景）。 */
  flushNow(): void {
    this.cancelScheduledFlush();
    const deltas = this.store.drainDeltas();
    if (deltas.length === 0) return;
    this.revisionValue += 1;
    const fromSeq = this.seq;
    this.seq += 1;
    this.lastFlushAt = this.now();
    const frame: ConversationTopicFrame = {
      topic: this.topic,
      subscriptionId: this.subscriptionId,
      fromSeq,
      toSeq: this.seq,
      sentAt: this.now(),
      payload: { kind: "deltas", deltas },
    };
    this.emitFrame(frame);
  }

  /** Read-only admission facts belong to the service, not to pane-local guesses. */
  applyReadOnly(readOnly: NonNullable<ConversationSnapshot["control"]["readOnly"]>): void {
    this.store.state.control = { ...this.store.state.control, readOnly };
  }

  /** 当前快照（不发帧；给需要直接读状态的调用方）。 */
  snapshot(): ConversationSnapshot {
    return this.store.snapshot(this.seq, this.revisionValue);
  }

  dispose(): void {
    this.disposed = true;
    this.cancelScheduledFlush();
    this.listeners.clear();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.disposed || this.cancelFlush) return;
    const elapsed = this.now() - this.lastFlushAt;
    const delay = Math.max(0, this.streamFlushIntervalMs - elapsed);
    this.cancelFlush = this.schedule(() => {
      this.cancelFlush = undefined;
      this.flushNow();
    }, delay);
  }

  private cancelScheduledFlush(): void {
    this.cancelFlush?.();
    this.cancelFlush = undefined;
  }

  private emitSnapshotToAll(): void {
    for (const listener of Array.from(this.listeners)) this.emitSnapshot(listener);
  }

  private emitSnapshot(listener: (frame: ConversationTopicFrame) => void): void {
    // 快照包含当前全部行，所以未下发的增量作废；水位推进一格作为对齐点。
    this.cancelScheduledFlush();
    this.store.drainDeltas();
    this.revisionValue += 1;
    this.seq += 1;
    const snapshot = this.store.snapshot(this.seq, this.revisionValue);
    this.store.markAllEmitted();
    const frame: ConversationTopicFrame = {
      topic: this.topic,
      subscriptionId: this.subscriptionId,
      fromSeq: 0,
      toSeq: this.seq,
      sentAt: this.now(),
      payload: { kind: "snapshot", snapshot },
    };
    try {
      listener(frame);
    } catch (error) {
      this.logger?.warn("nek projection frame listener threw", error);
    }
  }

  private emitFrame(frame: ConversationTopicFrame): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(frame);
      } catch (error) {
        this.logger?.warn("nek projection frame listener threw", error);
      }
    }
  }
}

export type NekProjectionPhase = SessionPhase;
