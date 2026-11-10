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

/** 快照在生命周期事件之间最多重取几次；仍不一致就显式失败，绝不冒充成功。 */
const MAX_SNAPSHOT_ATTEMPTS = 3;

/**
 * 快照没有落在一致的生命周期/会话上：整批作废，错误可见且可重试。
 *
 * 绝不返回"成功"：调用方要么把失败交给用户（创建/恢复/订阅），要么在后台刷新里
 * catch 后记日志并保留实时投影——但不能把陈旧快照当成已装载。
 */
export class NekSnapshotStaleError extends Error {
  readonly code = "nek.snapshotUnsettled";

  constructor(message: string) {
    super(message);
    this.name = "NekSnapshotStaleError";
  }
}

/**
 * 落地前确认快照仍然属于当前记录/进程。
 *
 * 关闭会话或更换进程（回收重连、fork）之后到达的响应必须整批丢弃：
 * 否则会把已关闭的会话重新写进路径索引、覆盖新进程的状态并收口旧队列。
 */
function assertSnapshotTarget(record: NekSessionRecord, process: NekRpcProcess): void {
  if (record.closing)
    throw new NekSnapshotStaleError(`nek session ${record.key} is closing; snapshot discarded`);
  if (record.process !== process)
    throw new NekSnapshotStaleError(
      `nek session ${record.key} process changed; snapshot discarded`,
    );
}

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
    assertSnapshotTarget(record, process);
    const epoch = record.stateEpoch ?? 0;
    const state = await process.client.call({ type: "get_state" });
    if ((record.stateEpoch ?? 0) !== epoch) continue;
    assertSnapshotTarget(record, process);
    record.state = state;
    record.sessionId = state.sessionId || record.sessionId;
    record.path = state.sessionFile ?? record.path;
    context.bindPath(record);
    if (state.isStreaming || state.isCompacting) context.setPhase(record, "running");
    return;
  }
  throw new NekSnapshotStaleError(
    `nek session ${record.key} state kept changing during initialise (${MAX_SNAPSHOT_ATTEMPTS} attempts); retry`,
  );
}

/** 用 get_entries / get_state / get_session_stats 重建投影器快照（带世代 fence）。 */
export async function reloadSessionSnapshot(
  context: NekSessionSnapshotContext,
  process: NekRpcProcess,
): Promise<void> {
  const { record } = context;
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    assertSnapshotTarget(record, process);
    const epoch = record.stateEpoch ?? 0;
    const [state, entries, stats] = await Promise.all([
      process.client.call({ type: "get_state" }),
      process.client.call({ type: "get_entries" }),
      process.client.call({ type: "get_session_stats" }),
    ]);
    assertSnapshotTarget(record, process);
    if ((record.stateEpoch ?? 0) !== epoch) continue;
    // Registry must not predate the persisted spawn facts used to reconstruct child rows.
    const extension = await process.client.call({
      type: "extension_call",
      method: "nek.get_state",
    });
    // 取快照期间发生了压缩/回合边界：这批事实属于更早的生命周期，丢弃重取。
    if ((record.stateEpoch ?? 0) !== epoch) continue;
    // 关闭/换进程同样整批作废：迟到的响应不能再落地。
    assertSnapshotTarget(record, process);
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
  throw new NekSnapshotStaleError(
    `nek session ${record.key} snapshot stayed unsettled across lifecycle events (${MAX_SNAPSHOT_ATTEMPTS} attempts); retry`,
  );
}
