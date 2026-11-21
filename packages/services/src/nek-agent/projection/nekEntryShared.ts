import type {
  ConversationRow,
  PlanItem,
  SessionConfigState,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  NekAgentMessage,
  NekCustomMessageEntry,
  NekRpcSessionState,
  NekSessionEntry,
  NekSessionStats,
  NekState,
} from "@zcode/shared/nek-protocol";
import { NEK_PLAN_PREVIEW } from "./nekPlanArtifact.js";
import { buildUserInputRow, contentText, toEpochMs, type NekRowIdentity } from "./nekRows.js";

/**
 * entries 路径的共享类型与行身份分配器。
 *
 * rowId 是 v4 的单调数字身份，entityId 是稳定业务身份（`<entryId>#<内容块序号>` /
 * `tool:<toolCallId>`）：重建快照时复用同一张 entityId → rowId 表，保证行不会"换 ID 重来"。
 */

export interface NekSnapshotInput {
  sessionId: string;
  entries: NekSessionEntry[];
  leafId?: string | null;
  messages?: NekAgentMessage[];
  /** Explicit cold child liveness; otherwise use state.isStreaming (absent state means stopped). */
  isSessionRunning?: boolean;
  state?: NekRpcSessionState;
  stats?: NekSessionStats;
  /** `get_info`/`session_info_changed` 给的会话名。 */
  title?: string;
  /** `extension_call nek.get_state` 的计划/模式与子代理注册表；采样不得早于 entries。 */
  nekState?: NekState;
  /** Source history is already branch-ordered and owns turn/row identities. */
  historyLayout?: {
    turnId: string;
    selection?: { provider?: string; model?: string; thought?: string };
    resolve: (entityId: string) => number;
    subagentAnchors?: ReadonlyMap<string, { turnId: string; parentToolCallId?: string }>;
  };
  /** 已经存在的行（增量刷新时用于复用 rowId）。 */
  existing?: { rows: ConversationRow[]; byEntity: Map<string, number>; nextRowId: number };
}

export interface NekProjectedSnapshot {
  rows: ConversationRow[];
  byEntity: Map<string, number>;
  nextRowId: number;
  title: string;
  config: SessionConfigState;
  usage: SessionUsageState;
  plan: { items: PlanItem[]; updatedAt: number } | null;
  mode: string;
}

/** 沿 `parentId` 从叶子回溯出当前分支（逆序后返回正序）。 */
export function orderActiveBranch(
  entries: readonly NekSessionEntry[],
  leafId?: string | null,
): NekSessionEntry[] {
  if (entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const candidateLeaf = leafId && byId.has(leafId) ? leafId : entries[entries.length - 1]?.id;
  const path: NekSessionEntry[] = [];
  const seen = new Set<string>();
  let cursor = candidateLeaf;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) break;
    path.push(entry);
    cursor = entry.parentId ?? undefined;
  }
  return path.reverse();
}

/** 行身份分配器：同一 entityId 永远拿同一个 rowId（已有的行沿用旧 rowId）。 */
export class RowAllocator {
  private readonly byEntity: Map<string, number>;
  private readonly existingRows: Map<number, ConversationRow>;
  private nextRowId: number;

  constructor(
    existing?: NekSnapshotInput["existing"],
    private readonly resolveStable?: (entityId: string) => number,
  ) {
    this.byEntity = new Map(existing?.byEntity ?? []);
    this.nextRowId = existing?.nextRowId ?? 1;
    this.existingRows = new Map((existing?.rows ?? []).map((row) => [row.rowId, row]));
  }

  resolve(entityId: string): number {
    const known = this.byEntity.get(entityId);
    if (known !== undefined) return known;
    const rowId = this.resolveStable ? this.resolveStable(entityId) : this.nextRowId;
    this.nextRowId = Math.max(this.nextRowId, rowId + 1);
    this.byEntity.set(entityId, rowId);
    return rowId;
  }

  previous(rowId: number): ConversationRow | undefined {
    return this.existingRows.get(rowId);
  }

  /** 已分配的 entityId → rowId（供投影器在重建后继续复用身份）。 */
  get entityMap(): Map<string, number> {
    return this.byEntity;
  }

  get nextId(): number {
    return this.nextRowId;
  }
}

export function completedTurnState(reason: string | undefined) {
  return reason === "aborted"
    ? "completedInterrupted"
    : reason === "error"
      ? "failed"
      : "completedSuccess";
}

export interface TurnContext {
  turnId: string;
  entityId: string;
  startedAt: number;
}

export function identity(
  entityId: string,
  rowId: number,
  turnId: string,
  createdAt: number,
): NekRowIdentity {
  return { entityId, rowId, turnId, createdAt };
}

/** 可见 custom 条目用于外部注入的上下文；计划行由计划制品条目拥有。 */
export function projectCustomMessage(
  entry: NekCustomMessageEntry,
  turn: TurnContext,
  allocator: RowAllocator,
): ConversationRow | null {
  if (entry.customType === NEK_PLAN_PREVIEW) return null;
  // 其他 custom 消息等价于"注入的用户侧上下文"：用 synthetic 来源的 userInput 呈现。
  const text = contentText(entry.content as string | Array<{ type: string }>);
  if (text.trim() === "") return null;
  const entityId = `custom:${entry.id}:${entry.customType}`;
  const rowId = allocator.resolve(entityId);
  return buildUserInputRow(identity(entityId, rowId, turn.turnId, toEpochMs(entry.timestamp)), {
    text,
    origin: "synthetic",
  });
}
