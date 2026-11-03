/**
 * task index 的“只补缺失行”写入：sessions-index 首帧基线、基线外新出现的外部会话
 * （例如在终端里用 CLI 新建的会话）与会话目录导入共用同一套规则。
 *
 * - 只做原子 insert-if-missing：已有行（含已删除）的 pin/archive/unread/手动标题原样保留；
 * - 固定小批次写入：历史会话可能很多，不能一次创建等量 Promise 挤占 host 事件循环；
 * - 失败逐条计数、只保留首个错误，由调用方汇总成一条日志，避免日志风暴。
 */
import {
  generateTraceId,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
  type ZCodeSessionInfo,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type { SessionPhase, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";

const TASK_ROW_SEED_BATCH_SIZE = 64;

interface TaskRowSeedResult {
  inserted: number;
  failed: number;
  firstError?: unknown;
}

function taskStatusFromSummaryPhase(phase: SessionPhase): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined;
  }
}

/** sessions-index 摘要 → 基线 task 行。 */
export function taskMetaFromSessionSummary(
  target: ZCodeAgentWorkspaceTarget,
  summary: SessionSummary,
): ZCodeTaskMeta {
  const status = taskStatusFromSummaryPhase(summary.phase);
  return {
    taskId: summary.sessionId,
    traceId: generateTraceId(summary.sessionId),
    title: summary.title,
    ...(summary.titleSource === "custom" ? { titleOverridden: true } : {}),
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    createdAt: summary.createdAt,
    updatedAt: summary.lastActivityAt,
    mode: "agent",
    provider: ZCODE_AGENT_PROVIDER,
    ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
    ...(status ? { status } : {}),
  };
}

/**
 * 会话目录里的会话能否作为顶层任务导入：只认本 workspace 的主会话与 fork；
 * 子代理 child、划词侧聊和已归档会话不进主列表。
 */
export function isImportableSessionInfo(
  target: ZCodeAgentWorkspaceTarget,
  session: ZCodeSessionInfo,
): boolean {
  if (session.sessionKind !== "interactive" && session.sessionKind !== "fork") return false;
  if (session.archivedAt !== undefined) return false;
  return resolveWorkspaceKey(session.workspace) === resolveWorkspaceKey(target);
}

/**
 * 会话目录条目 → 基线 task 行。导入的会话不归 GUI 的 runtime 管（可能仍在终端里运行），
 * 没有后续终态事件能收口 running，因此除 error 外一律按空闲（completed）落行，
 * 打开会话时再由完整 snapshot 写权威状态。
 */
export function taskMetaFromSessionInfo(
  target: ZCodeAgentWorkspaceTarget,
  session: ZCodeSessionInfo,
): ZCodeTaskMeta {
  return {
    taskId: session.sessionId,
    traceId: session.traceId ?? generateTraceId(session.sessionId),
    title: session.title,
    ...(session.titleSource === "custom" ? { titleOverridden: true } : {}),
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    mode: "agent",
    provider: ZCODE_AGENT_PROVIDER,
    ...(session.parentSessionId ? { forkedFromTaskId: session.parentSessionId } : {}),
    status: session.status === "error" ? "error" : "completed",
  };
}

/** 小批次 insert-if-missing；返回新增行数与失败汇总。 */
export async function seedMissingTaskRows(
  repo: Pick<TaskIndexRepo, "seedTaskMetaIfMissing">,
  metas: readonly ZCodeTaskMeta[],
): Promise<TaskRowSeedResult> {
  const result: TaskRowSeedResult = { inserted: 0, failed: 0 };
  for (let offset = 0; offset < metas.length; offset += TASK_ROW_SEED_BATCH_SIZE) {
    const batch = metas.slice(offset, offset + TASK_ROW_SEED_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((meta) => repo.seedTaskMetaIfMissing(meta)));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        if (outcome.value.inserted) result.inserted += 1;
        continue;
      }
      result.failed += 1;
      result.firstError ??= outcome.reason;
    }
  }
  return result;
}
