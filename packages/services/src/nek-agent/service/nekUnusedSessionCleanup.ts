import type { NekSessionRecord } from "./types.js";

interface UnusedSessionCleanupDeps {
  deleteSession: (input: { sessionKey: string; sessionPath: string }) => Promise<void>;
  logger?: { warn: (...args: unknown[]) => void };
}

/**
 * 退出前删除本次运行新建、但没有任何消息的会话（草稿页预热会话、建好却没发送的新任务）。
 *
 * nek 一建会话就落盘，会话列表虽然不列没有消息的会话，文件仍会留在会话目录。判据与列表一致：
 * 会话进程报告的 `messageCount === 0`。逐个失败只记录告警，不影响其他会话的清理与服务退出。
 */
export async function deleteUnusedCreatedSessions(
  records: readonly NekSessionRecord[],
  deps: UnusedSessionCleanupDeps,
): Promise<void> {
  const candidates = records.filter((record) => record.createdThisRun && record.process);
  await Promise.all(candidates.map(async (record) => await deleteIfUnused(record, deps)));
}

async function deleteIfUnused(
  record: NekSessionRecord,
  deps: UnusedSessionCleanupDeps,
): Promise<void> {
  try {
    const state = await record.process!.client.call({ type: "get_state" });
    if (state.messageCount > 0) return;
    const sessionPath = state.sessionFile ?? record.path;
    if (!sessionPath) throw new Error("nek did not report the session file");
    await deps.deleteSession({ sessionKey: record.key, sessionPath });
  } catch (error) {
    deps.logger?.warn(
      "failed to delete an unused nek session on shutdown",
      record.sessionId,
      error,
    );
  }
}
