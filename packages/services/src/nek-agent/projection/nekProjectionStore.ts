import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  PlanItem,
  QueueItem,
  SessionConfigState,
  SessionControl,
  SessionUsageState,
  StreamablePath,
  StatePatch,
} from "@zcode/shared/zcode-protocol-v4";
import { buildControlProjection, buildConversationSnapshot } from "./nekProjectionSnapshot.js";

/**
 * 投影状态容器：行窗口 + 待下发增量。
 *
 * 这里是 v4 增量语义的唯一落点（`row.appended` / `row.upserted` / `row.delta`）：
 * - 首次出现的行走 `row.appended`（带完整内容）；
 * - 结构变化（状态迁移、权威内容替换）走 `row.upserted`（整行替换）；
 * - 只有流式文本增长走 `row.delta`（协议的 streamable path）。
 *
 * 不变量：`row.delta` 不能作用于尚未 appended 的行；因此新行在首批里必须以 appended 形式下发，
 * 且其已累积的文本随整行一起下发（同时清掉该行的待发 append）。
 */

export interface NekProjectionState {
  title: string;
  config: SessionConfigState;
  usage: SessionUsageState;
  plan: { items: PlanItem[]; updatedAt: number } | null;
  control: SessionControl;
  queue: { items: QueueItem[]; autoDrain: boolean };
}

export interface NekProjectionStoreOptions {
  sessionId: string;
  logEpoch: string;
  initialState: NekProjectionState;
  /** 行窗口上限（有界内存）；默认 5000。超出后丢最旧的行。 */
  maxWindowRows?: number;
  /** 沿用已存在的行身份（增量刷新时用）。 */
  existing?: { rows: ConversationRow[]; byEntity: Map<string, number>; nextRowId: number };
}

const DEFAULT_MAX_WINDOW_ROWS = 5000;

export class NekProjectionStore {
  private readonly rows: ConversationRow[];
  private readonly byEntity: Map<string, number>;
  private readonly emitted = new Set<number>();
  private readonly needsUpsert = new Set<number>();
  private readonly pendingStream = new Map<
    number,
    Array<{ path: StreamablePath; append: string }>
  >();
  private readonly maxWindowRows: number;
  private nextRowId: number;
  private firstRowId: number | null;
  private totalCount: number;
  private stateValue: NekProjectionState;
  private pendingState: StatePatch | undefined;

  constructor(private readonly options: NekProjectionStoreOptions) {
    this.rows = [...(options.existing?.rows ?? [])];
    this.byEntity = new Map(options.existing?.byEntity ?? []);
    this.nextRowId = options.existing?.nextRowId ?? 1;
    this.maxWindowRows = Math.max(1, options.maxWindowRows ?? DEFAULT_MAX_WINDOW_ROWS);
    this.firstRowId = this.rows[0]?.rowId ?? null;
    this.totalCount = this.rows.length;
    this.stateValue = options.initialState;
    if (this.rows.length > 0) {
      // 已存在的行视为"客户端已经持有"：之后只发 upsert/delta。
      for (const row of this.rows) this.emitted.add(row.rowId);
    }
  }

  get state(): Readonly<NekProjectionState> {
    return this.stateValue;
  }

  /** State-only events must cross the same flush boundary as rows; no snapshot polling. */
  setState(patch: Partial<NekProjectionState>): void {
    const previous = this.stateValue;
    const next = { ...previous };
    const changed: StatePatch = {};
    for (const key of ["config", "usage", "plan", "queue", "control"] as const) {
      if (patch[key] !== undefined && patch[key] !== previous[key]) {
        Object.assign(changed, { [key]: patch[key] });
        Object.assign(next, { [key]: patch[key] });
      }
    }
    if (patch.title !== undefined && patch.title !== previous.title) {
      changed.meta = { title: patch.title, titleSource: patch.title === "" ? "default" : "custom" };
      next.title = patch.title;
    }
    if (changed.control) Object.assign(changed, buildControlProjection(changed.control));
    if (Object.keys(changed).length === 0) return;
    this.stateValue = next;
    this.pendingState = { ...this.pendingState, ...changed };
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get logEpoch(): string {
    return this.options.logEpoch;
  }

  get window(): readonly ConversationRow[] {
    return this.rows;
  }

  get rowCount(): number {
    return this.totalCount;
  }

  /** 下一个待分配的 rowId（重建快照时传给分配器，保证 rowId 单调不复用）。 */
  get nextRowIdValue(): number {
    return this.nextRowId;
  }

  /** 当前 entityId → rowId 的副本（重建快照时复用身份）。 */
  get byEntitySnapshot(): Map<string, number> {
    return new Map(this.byEntity);
  }

  /** 取（或分配）某个实体身份的 rowId。 */
  allocate(entityId: string): number {
    const known = this.byEntity.get(entityId);
    if (known !== undefined) return known;
    const rowId = this.nextRowId;
    this.nextRowId += 1;
    this.byEntity.set(entityId, rowId);
    return rowId;
  }

  findRowId(entityId: string): number | undefined {
    return this.byEntity.get(entityId);
  }

  getRow<T extends ConversationRow>(rowId: number): T | undefined {
    const found = this.rows.find((row) => row.rowId === rowId);
    return found as T | undefined;
  }

  /** 追加一行（尾部）；同一 rowId 再追加会被忽略。 */
  add(row: ConversationRow): void {
    if (this.rows.some((existing) => existing.rowId === row.rowId)) {
      this.update(row.rowId, () => row);
      return;
    }
    this.rows.push(row);
    this.totalCount += 1;
    this.firstRowId ??= row.rowId;
    this.trim();
  }

  /** 整行替换（结构变化）。 */
  update(rowId: number, updater: (row: ConversationRow) => ConversationRow): void {
    const index = this.rows.findIndex((row) => row.rowId === rowId);
    if (index === -1) return;
    const current = this.rows[index];
    if (!current) return;
    const next = updater(current);
    if (next === current) return;
    this.rows[index] = next;
    this.needsUpsert.add(rowId);
    this.pendingStream.delete(rowId);
  }

  /** 流式文本增长：同时改内存行与待发 append，保证两侧一致。 */
  appendStream(rowId: number, path: StreamablePath, append: string): void {
    if (append === "") return;
    const index = this.rows.findIndex((row) => row.rowId === rowId);
    if (index === -1) return;
    const current = this.rows[index];
    if (!current) return;
    const next = applyAppend(current, path, append);
    if (next === current) return;
    this.rows[index] = next;
    if (this.needsUpsert.has(rowId)) return;
    const list = this.pendingStream.get(rowId) ?? [];
    list.push({ path, append });
    this.pendingStream.set(rowId, list);
  }

  /** 取走待下发增量（按 rowId 升序，保证确定性）。 */
  drainDeltas(): ConversationDelta[] {
    const deltas: ConversationDelta[] = [];
    const rowIds = this.rows.map((row) => row.rowId).sort((left, right) => left - right);
    for (const rowId of rowIds) {
      const row = this.rows.find((candidate) => candidate.rowId === rowId);
      if (!row) continue;
      if (!this.emitted.has(rowId)) {
        deltas.push({ op: "row.appended", row });
        this.emitted.add(rowId);
        this.needsUpsert.delete(rowId);
        this.pendingStream.delete(rowId);
        continue;
      }
      if (this.needsUpsert.has(rowId)) {
        deltas.push({ op: "row.upserted", row });
        this.needsUpsert.delete(rowId);
        this.pendingStream.delete(rowId);
        continue;
      }
      const pending = this.pendingStream.get(rowId);
      if (!pending) continue;
      for (const entry of pending) {
        deltas.push({ op: "row.delta", rowId, path: entry.path, append: entry.append });
      }
      this.pendingStream.delete(rowId);
    }
    if (this.pendingState) {
      deltas.push({ op: "state.updated", patch: this.pendingState });
      this.pendingState = undefined;
    }
    return deltas;
  }

  /** 是否还有未下发的增量（调度器据此决定要不要 flush）。 */
  get hasPendingDeltas(): boolean {
    return (
      this.pendingState !== undefined ||
      this.needsUpsert.size > 0 ||
      this.pendingStream.size > 0 ||
      this.rows.some((row) => !this.emitted.has(row.rowId))
    );
  }

  /** 快照：包含当前全部行（已下发的与未下发的都在，因为增量尚未发出）。 */
  snapshot(seq: number, revision: number): ConversationSnapshot {
    return buildConversationSnapshot({
      sessionId: this.options.sessionId,
      logEpoch: this.options.logEpoch,
      seq,
      revision,
      rows: [...this.rows],
      totalCount: this.totalCount,
      firstRowId: this.firstRowId,
      title: this.state.title,
      config: this.state.config,
      usage: this.state.usage,
      plan: this.state.plan,
      control: this.state.control,
      queue: this.state.queue,
    });
  }

  /** 发过快照后：所有行都视为客户端已持有，且待发增量作废（已包含在快照里）。 */
  markAllEmitted(): void {
    this.pendingState = undefined;
    for (const row of this.rows) this.emitted.add(row.rowId);
    this.needsUpsert.clear();
    this.pendingStream.clear();
  }

  /** 整份状态替换（重新读取 entries 后）。 */
  replaceRows(
    rows: readonly ConversationRow[],
    byEntity: Map<string, number>,
    nextRowId: number,
  ): void {
    this.rows.length = 0;
    this.rows.push(...rows);
    this.byEntity.clear();
    for (const [entityId, rowId] of byEntity) this.byEntity.set(entityId, rowId);
    this.nextRowId = nextRowId;
    this.totalCount = rows.length;
    this.firstRowId = rows[0]?.rowId ?? null;
    this.emitted.clear();
    this.needsUpsert.clear();
    this.pendingStream.clear();
  }

  private trim(): void {
    if (this.rows.length <= this.maxWindowRows) return;
    const drop = this.rows.length - this.maxWindowRows;
    this.rows.splice(0, drop);
    // 没有 rows/range 分页端点：裁剪后把窗口首行当作"已到顶"，UI 不会去请求不存在的更早分页。
    this.firstRowId = this.rows[0]?.rowId ?? this.firstRowId;
    this.totalCount = Math.max(this.rows.length, this.totalCount - drop);
  }
}

function applyAppend(row: ConversationRow, path: StreamablePath, append: string): ConversationRow {
  switch (path) {
    case "text":
      if (row.kind === "assistantText" || row.kind === "reasoning")
        return { ...row, text: row.text + append };
      return row;
    case "inputText":
      if (row.kind === "toolCall") return { ...row, inputText: row.inputText + append };
      return row;
    case "output.text":
      if (row.kind === "toolCall" && row.output)
        return { ...row, output: { ...row.output, text: row.output.text + append } };
      return row;
    case "summaryText":
      if (row.kind === "subagent") return { ...row, summaryText: row.summaryText + append };
      return row;
  }
}
