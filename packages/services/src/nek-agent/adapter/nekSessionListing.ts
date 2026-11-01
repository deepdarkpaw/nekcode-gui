import type { NekSessionSummary } from "@zcode/shared/nek-protocol";

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
