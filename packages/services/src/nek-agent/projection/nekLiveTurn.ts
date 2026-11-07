import type { NekRpcEvent } from "@zcode/shared/nek-protocol";
import type { NekRowIdentity } from "./nekRows.js";
import { buildTurnHeaderRow } from "./nekRows.js";
import type { NekProjectionStore } from "./nekProjectionStore.js";

/**
 * 事件流投影的共享状态与轮次机。
 *
 * 行身份（live 来源）：
 * - assistant 正文/思考：`resp:<assistantTimestamp>:text|thinking:<contentIndex>`
 *   （`message_update` 不带消息本体，只能用 `message_start` 记下的 response 身份）；
 * - 工具：`tool:<toolCallId>`（live 与 entries 两个来源都一致，最稳定）；
 * - 用户/自定义消息：`msg:<timestamp>:<role>`；bash：`bash:<timestamp>`；
 * - 时间线标记：`marker:<kind>:<serial>`。
 *
 * entries 路径（`loadSnapshot`）改用 `<entryId>#<内容块序号>`：两种来源的身份不同是故意的，
 * 重新读取会话一律以整份快照替换，客户端不会看到身份混用。
 */

export interface NekLiveTurn {
  entityId: string;
  turnId: string;
  startedAt: number;
  headerRowId: number;
  open: boolean;
  lastStopReason?: string;
}

export interface NekLiveContext {
  store: NekProjectionStore;
  now: () => number;
  turn?: NekLiveTurn;
  /** 当前 assistant response 的身份前缀（来自 `message_start.message.timestamp`）。 */
  assistantResponseKey?: string;
  assistantModel?: string;
  /** `resp:<...>:text:<i>` / `...:thinking:<i>` → rowId。 */
  streamRows: Map<string, number>;
  /** toolCallId → rowId。 */
  toolRows: Map<string, number>;
  /** v4 没有通用 details 字段，这里保留原始 details 供上层自取。 */
  toolDetails: Map<string, unknown>;
  markerSerial: number;
  /**
   * 正在进行的压缩所占据的 marker 行。
   *
   * 不变量：同一次压缩全生命周期占同一条 marker row（running → 终态 upsert），
   * 所以 `compaction_start` 只在这里登记身份，`compaction_end` 复用同一 rowId 收口，
   * 不再另起一条终态行（否则 running 行会永久残留并阻塞 `chatLoadingVisibility`）。
   */
  activeCompactEntityId: string | undefined;
  /** 刚收口的压缩行；紧随其后的 `entry_appended(compaction)` 把 summaryRef 补到这行上。 */
  lastCompletedCompactEntityId?: string;
  /** 上一个 `compaction_end` 已成功收口，等待同一次压缩的 `entry_appended(compaction)` 补摘要。 */
  pendingCompactionEntrySync: boolean;
}

export function createNekLiveContext(
  store: NekProjectionStore,
  now: () => number = Date.now,
): NekLiveContext {
  const header = store.window.findLast((row) => row.kind === "turnHeader");
  return {
    store,
    now,
    ...(header?.kind === "turnHeader" && header.entityId && header.state === "running"
      ? {
          turn: {
            entityId: header.entityId,
            turnId: header.turnId,
            startedAt: header.startedAt,
            headerRowId: header.rowId,
            open: true,
          },
        }
      : {}),
    streamRows: new Map(),
    toolRows: new Map(),
    toolDetails: new Map(),
    markerSerial: 0,
    activeCompactEntityId: undefined,
    pendingCompactionEntrySync: false,
  };
}

export function rowIdentity(
  entityId: string,
  rowId: number,
  turnId: string,
  createdAt: number,
): NekRowIdentity {
  return { entityId, rowId, turnId, createdAt };
}

export function currentTurnId(ctx: NekLiveContext): string {
  return ctx.turn?.turnId ?? "turn-0";
}

/** 确保有一轮在进行（没有就开一轮，并落下轮头行）。 */
export function ensureTurn(ctx: NekLiveContext, startedAt: number): NekLiveTurn {
  if (ctx.turn?.open) return ctx.turn;
  closeTurn(ctx, "completedSuccess");
  const entityId = `turn:${startedAt}`;
  const rowId = ctx.store.allocate(entityId);
  const turn: NekLiveTurn = {
    entityId,
    turnId: entityId,
    startedAt,
    headerRowId: rowId,
    open: true,
  };
  ctx.store.add(
    buildTurnHeaderRow(rowIdentity(entityId, rowId, entityId, startedAt), { state: "running" }),
  );
  ctx.turn = turn;
  return turn;
}

/** 结束当前轮（`agent_settled`、新用户输入到来、或回合被中止）。幂等。 */
export function closeTurn(
  ctx: NekLiveContext,
  state: "completedSuccess" | "completedInterrupted" | "failed",
): void {
  const turn = ctx.turn;
  if (!turn?.open) return;
  turn.open = false;
  ctx.store.update(turn.headerRowId, (row) =>
    row.kind === "turnHeader" ? { ...row, state, endedAt: ctx.now() } : row,
  );
}

/** 轮次级别的控制态（其余事件由 nekLiveProjection.ts 分发给各处理器）。 */
export function applyTurnLifecycleEvent(ctx: NekLiveContext, event: NekRpcEvent): boolean {
  if (event.type === "agent_start") {
    ctx.store.setState({
      control: {
        ...ctx.store.state.control,
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [{ kind: "primaryTurn", startedAt: ctx.now() }],
      },
    });
    return true;
  }
  if (event.type === "agent_settled") {
    closeTurn(
      ctx,
      ctx.turn?.lastStopReason === "aborted" ? "completedInterrupted" : "completedSuccess",
    );
    ctx.store.setState({
      control: {
        ...ctx.store.state.control,
        phase: "completedSuccess",
        sessionEnded: false,
        canStop: false,
        stopState: "idle",
        stopTargetKind: "unknown",
        activeWorks: [],
        apiRetry: null,
      },
    });
    return true;
  }
  return false;
}
