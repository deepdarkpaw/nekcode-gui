import type { NekRpcProcess } from "../nekRpcProcess.js";
import type { NekConversationProjector } from "../nekConversationProjector.js";
import { isNekState, type NekSessionPhase, type NekSessionRecord } from "./types.js";

/**
 * 会话状态与投影快照的装载，以及"生命周期世代"fence。
 *
 * `get_state` / `get_entries` / `get_session_stats` 是并行取的，各自耗时不同：
 * `get_state` 可能在压缩开始之前就取到 `isCompacting=false`，而整批要到压缩开始之后
 * 才完成。这不是 CLI 误报，而是真实的异步陈旧结果。因此快照只在捕获的世代没有变化时
 * 才允许落地（覆盖 `state`、重建投影、收口待发输入）；世代变了就整批作废重取。
 *
 * 只有 `agent_start` / `agent_settled` / `compaction_start` / `compaction_end`、
 * 手动压缩预约与停止会推进世代——也就是任何可能改变"能否接纳输入"的事实。
 */

/** 快照在生命周期事件之间最多重取几次；仍陈旧就保留实时事件、不覆盖。 */
const MAX_SNAPSHOT_ATTEMPTS = 3;

export interface NekSessionSnapshotContext {
  record: NekSessionRecord;
  createProjector: (record: NekSessionRecord) => NekConversationProjector;
  setPhase: (record: NekSessionRecord, phase: NekSessionPhase) => void;
  settlePendingInputs: (record: NekSessionRecord) => void;
  /** 会话文件路径可能随 fork/恢复变化，落地时同步更新路径索引。 */
  bindPath: (record: NekSessionRecord) => void;
  logger?: { warn: (...args: unknown[]) => void };
}

/** 推进生命周期世代：异步快照据此判定自己是否已经过时。 */
export function bumpStateEpoch(record: NekSessionRecord): void {
  record.stateEpoch = (record.stateEpoch ?? 0) + 1;
}

/** 启动后用 `get_state` 定初始状态；期间来了生命周期事件就重取，绝不覆盖新事实。 */
export async function initializeSessionState(
  context: NekSessionSnapshotContext,
  process: NekRpcProcess,
): Promise<void> {
  const { record } = context;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const epoch = record.stateEpoch ?? 0;
    const state = await process.client.call({ type: "get_state" });
    if ((record.stateEpoch ?? 0) !== epoch) continue;
    record.state = state;
    record.sessionId = state.sessionId || record.sessionId;
    record.path = state.sessionFile ?? record.path;
    context.bindPath(record);
    if (state.isStreaming || state.isCompacting) context.setPhase(record, "running");
    return;
  }
  context.logger?.warn(
    "nek session state kept changing while initialising; keeping live events",
    record.key,
  );
}

/** 用 get_entries / get_state / get_session_stats 重建投影器快照（带世代 fence）。 */
export async function reloadSessionSnapshot(
  context: NekSessionSnapshotContext,
  process: NekRpcProcess,
): Promise<void> {
  const { record } = context;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const epoch = record.stateEpoch ?? 0;
    const [state, entries, stats, extension] = await Promise.all([
      process.client.call({ type: "get_state" }),
      process.client.call({ type: "get_entries" }),
      process.client.call({ type: "get_session_stats" }),
      process.client.call({ type: "extension_call", method: "nek.get_state" }),
    ]);
    // 取快照期间发生了压缩/回合边界：这批事实属于更早的生命周期，丢弃重取。
    if ((record.stateEpoch ?? 0) !== epoch) continue;
    record.state = state;
    record.sessionId = state.sessionId || record.sessionId;
    record.path = state.sessionFile ?? record.path;
    context.bindPath(record);
    const projector = (record.projector ??= context.createProjector(record));
    projector.loadSnapshot({
      entries: entries.entries,
      leafId: entries.leafId,
      state,
      stats,
      nekState: isNekState(extension.result) ? extension.result : undefined,
      title: state.sessionName,
    });
    projector.flushNow();
    context.setPhase(record, state.isStreaming || state.isCompacting ? "running" : "idle");
    // 快照是权威事实：压缩已经收口（或从未开始）时，把 GUI 暂存的输入放行。
    context.settlePendingInputs(record);
    return;
  }
  context.logger?.warn(
    "nek snapshot stayed stale across lifecycle events; keeping live projection",
    record.key,
  );
}
