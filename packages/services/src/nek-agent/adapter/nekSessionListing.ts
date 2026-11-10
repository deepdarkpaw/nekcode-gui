import type { NekSessionSummary } from "@zcode/shared/nek-protocol";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import type { NekSessionIndexItem } from "../index/types.js";
import type { NekSession } from "../service/types.js";

/**
 * 会话列表（sessions-index 与 legacy listSessions）是否列出该会话的唯一判断。
 *
 * 没有消息的会话是草稿：草稿页的预热会话、或首发尚未写入的新会话。沿用 ZCodium 约定，
 * 草稿不进会话列表。nek 会把空会话落盘，并以 "(no messages)" 作为首条消息占位，
 * 不过滤就会在侧栏出现无内容的会话。
 */
export function isListedNekSession(summary: NekSessionSummary): boolean {
  return summary.messageCount > 0;
}

/** 磁盘目录只提供历史元数据；实时 phase 来自同一 service owner，否则侧栏永远不转圈。 */
export function projectNekSessionSummary(
  item: NekSessionIndexItem,
  workspaceId: string,
  live?: NekSession,
): SessionSummary | undefined {
  const summary = item.summary;
  if (!summary || !isListedNekSession(summary)) return undefined;
  const phase =
    live?.phase === "running" || live?.phase === "waiting_input"
      ? "running"
      : live?.phase === "error"
        ? "error"
        : live?.readonly || (summary.locked && !live)
          ? "completedInterrupted"
          : "completedSuccess";
  return {
    sessionId: summary.id,
    workspaceId,
    title: summary.name ?? summary.firstMessage,
    phase,
    sessionEnded: phase !== "running",
    hasBackgroundWork: false,
    lastActivityAt: Date.parse(summary.modifiedAt),
    createdAt: Date.parse(summary.createdAt),
  };
}
