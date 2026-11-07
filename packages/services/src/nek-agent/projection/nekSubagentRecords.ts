import type { NekSessionEntry, NekSubagentRecord } from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { subagentRowFromRecord } from "./nekProjectionSnapshot.js";

/**
 * 持久化条目里的子代理事实。
 *
 * nek 的 `subagent-registry` 是纯内存表：关闭 GUI（或重启 nek）后 `nek.get_state` 的
 * `subagents` 一律为空。子代理的唯一持久化事实写在 `subagent` / `await` / `stop_subagent`
 * 三个工具的 toolResult 消息 `details` 里（`{ subagent }` 或 `{ subagents, running }`），
 * 因此时间线投影、状态槽快照与右侧预览都必须能从 entries 复原同一批记录。
 */

/** `subagent` 工具：`details.subagent` 是刚启动（或已结束）的子代理记录。 */
const SUBAGENT_TOOL = "subagent";
/** `await` 工具：`details.subagents` 是已完成的记录，`details.running` 是仍在运行的记录。 */
const AWAIT_TOOL = "await";
/** `stop_subagent` 工具：`details.subagent` 是被停止后的记录。 */
const STOP_SUBAGENT_TOOL = "stop_subagent";

const SUBAGENT_STATUSES: readonly NekSubagentRecord["status"][] = [
  "running",
  "completed",
  "errored",
  "aborted",
];

function isSubagentStatus(value: unknown): value is NekSubagentRecord["status"] {
  return SUBAGENT_STATUSES.some((status) => status === value);
}

/**
 * 严格类型守卫：只认 nek 真正写进 `NekSubagentRecord` 的字段，不为缺失字段编造默认值。
 *
 * `details` 是工具私有载荷，形状漂移必须先被识别出来，而不是让半个记录混进时间线。
 */
export function isNekSubagentRecord(value: unknown): value is NekSubagentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<NekSubagentRecord>;
  return (
    typeof record.id === "string" &&
    record.id !== "" &&
    typeof record.description === "string" &&
    typeof record.type === "string" &&
    record.type !== "" &&
    typeof record.background === "boolean" &&
    isSubagentStatus(record.status) &&
    typeof record.startedAt === "number" &&
    Number.isFinite(record.startedAt)
  );
}

interface ExtractedSubagentRecord {
  record: NekSubagentRecord;
  /**
   * `subagent` 工具调用 id：子代理卡（`SubagentRow`）的父锚点。
   * `await` / `stop_subagent` 只是同一子代理的状态更新，不带新的父锚点。
   */
  parentToolCallId?: string;
}

function pushRecord(
  target: ExtractedSubagentRecord[],
  value: unknown,
  parentToolCallId?: string,
): void {
  if (!isNekSubagentRecord(value)) return;
  target.push(
    parentToolCallId === undefined ? { record: value } : { record: value, parentToolCallId },
  );
}

function pushRecords(target: ExtractedSubagentRecord[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) pushRecord(target, item);
}

/**
 * 从一条 toolResult 里取出子代理记录；非子代理工具返回空数组。
 *
 * 这里只做"这条结果携带了哪些子代理"的解析，合并顺序由调用方决定。
 */
export function extractSubagentsFromToolResult(
  toolName: string,
  toolCallId: string,
  details: unknown,
): ExtractedSubagentRecord[] {
  if (typeof details !== "object" || details === null) return [];
  const payload = details as { subagent?: unknown; subagents?: unknown; running?: unknown };
  const extracted: ExtractedSubagentRecord[] = [];
  if (toolName === SUBAGENT_TOOL) {
    pushRecord(extracted, payload.subagent, toolCallId);
    return extracted;
  }
  if (toolName === STOP_SUBAGENT_TOOL) {
    pushRecord(extracted, payload.subagent);
    return extracted;
  }
  if (toolName === AWAIT_TOOL) {
    pushRecords(extracted, payload.subagents);
    pushRecords(extracted, payload.running);
    return extracted;
  }
  return extracted;
}

/**
 * 冷恢复归一化（ARD.md 3.2 重开语义）：父会话已经不在运行态时，残留的 `"running"` 记录
 * 不可能真的还在跑（进程退出前没写终态），收敛为 `"aborted"`，避免重开后永远显示假运行中。
 *
 * 结束时间取最后一次活动；连活动都没有就用启动时刻——两者都是 nek 观测到的真实时间戳，
 * 不是估算值。
 */
function normalizePersistedSubagentRecord(
  record: NekSubagentRecord,
  sessionRunning: boolean,
): NekSubagentRecord {
  if (sessionRunning || record.status !== "running") return record;
  return {
    ...record,
    status: "aborted",
    endedAt: record.endedAt ?? record.lastActivityAt ?? record.startedAt,
  };
}

interface PersistedSubagent {
  record: NekSubagentRecord;
  /** 首次 `subagent` 调用绑定的父工具调用 id；后续更新不覆盖。 */
  parentToolCallId?: string;
}

/** 投影期保存的子代理行锚点：父工具调用 id 与所属回合只由首次出现决定。 */
export interface SubagentRowAnchor {
  turnId: string;
  parentToolCallId?: string;
}

/** 一条 toolResult 投影出的 subagent 行与新锚点表（纯函数：不改入参）。 */
interface SubagentRowPlan {
  anchors: Map<string, SubagentRowAnchor>;
  rows: ConversationRow[];
}

/**
 * 一条 toolResult 的子代理更新 → subagent 行。
 *
 * 首次出现确定 `turnId` 与父工具调用 id；之后的 `await` / `stop_subagent` 只刷新同一
 * 行（同一 entityId、同一 rowId）的状态事实，父锚点保持不变。
 */
export function planSubagentRows(
  anchorsInput: ReadonlyMap<string, SubagentRowAnchor>,
  toolResult: { toolName: string; toolCallId: string; details?: unknown },
  turnId: string,
  sessionRunning: boolean,
  allocate: (entityId: string) => number,
): SubagentRowPlan {
  const anchors = new Map(anchorsInput);
  const rows: ConversationRow[] = [];
  for (const extracted of extractSubagentsFromToolResult(
    toolResult.toolName,
    toolResult.toolCallId,
    toolResult.details,
  )) {
    const entityId = `subagent:${extracted.record.id}`;
    const known = anchors.get(entityId);
    const rowTurnId = known?.turnId ?? turnId;
    const parentToolCallId = known?.parentToolCallId ?? extracted.parentToolCallId;
    anchors.set(entityId, {
      turnId: rowTurnId,
      ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
    });
    const rowId = allocate(entityId);
    rows.push(
      subagentRowFromRecord(
        entityId,
        rowId,
        rowTurnId,
        normalizePersistedSubagentRecord(extracted.record, sessionRunning),
        parentToolCallId,
      ),
    );
  }
  return { anchors, rows };
}

/**
 * 扫描 entries，按出现顺序合并同一 `id` 的子代理记录。
 *
 * 后出现的记录覆盖状态/结束时间/用量/finalText/error/sessionFile 等事实（`await` /
 * `stop_subagent` 的 `details` 是完整快照），但父锚点保留首次 `subagent` 调用绑定值：
 * 那是"哪个工具调用 spawn 了它"的稳定身份，后续更新无权改写。
 */
export function collectPersistedSubagentRecords(
  entries: readonly NekSessionEntry[],
  options: { sessionRunning?: boolean } = {},
): Map<string, PersistedSubagent> {
  const sessionRunning = options.sessionRunning === true;
  const collected = new Map<string, PersistedSubagent>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "toolResult") continue;
    const result = entry.message;
    for (const extracted of extractSubagentsFromToolResult(
      result.toolName,
      result.toolCallId,
      result.details,
    )) {
      const previous = collected.get(extracted.record.id);
      const merged = previous ? { ...previous.record, ...extracted.record } : extracted.record;
      const parentToolCallId = previous?.parentToolCallId ?? extracted.parentToolCallId;
      collected.set(extracted.record.id, {
        record: normalizePersistedSubagentRecord(merged, sessionRunning),
        ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
      });
    }
  }
  return collected;
}
