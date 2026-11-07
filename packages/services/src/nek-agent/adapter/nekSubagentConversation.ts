import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import type {
  NekAgentMessage,
  NekSessionEntry,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import type { NekRpcClient } from "../nekRpcClient.js";
import { projectEntries } from "../projection/nekEntryProjection.js";
import { collectPersistedSubagentRecords } from "../projection/nekSubagentRecords.js";
import { isNekSessionSnapshot, isNekState } from "../service/types.js";
import type { NekAgentServiceAdapterLegacyTarget } from "./nekAgentServiceAdapterLegacySupport.js";

/**
 * 子代理文件不在普通会话目录里，且生命周期由父 nek 所有。
 * 从父会话验证身份并读取其报告的文件，只做标准 v4 投影，不 resume 子会话。
 */
export function createNekSubagentConversationReader(
  owner: NekAgentServiceAdapterLegacyTarget,
  maxRows = DEFAULT_GUI_RUNTIME_CONFIG.events.eventBufferEntries,
): IZCodeAgentService["getSubagentConversation"] {
  return async (input) => {
    const { sessionKey } = await owner.ensureNekSessionBinding(input, input.sessionId);
    return await owner.service.runSessionCommand(sessionKey, async (context) => {
      const parent = context.target(sessionKey);
      const { result } = await parent.client.call({
        type: "extension_call",
        method: "nek.get_state",
      });
      if (!isNekState(result)) throw new Error("nek returned an invalid subagent state");
      const live = result.subagents.find((child) => child.id === input.id);
      // nek 的 registry 是纯内存表：重开 GUI 后历史子代理只剩父会话 entries 里的
      // toolResult details，必须从那里复原身份，否则点击历史子代理直接报错。
      const restored = live ? undefined : await restoreSubagentRecord(parent, input.id);
      const record = live ?? restored;
      if (!record) throw new Error(`Unknown subagent ${input.id} in parent session`);
      let entries: NekSessionEntry[];
      let leafId: string | null | undefined;
      if (record.status !== "running" && record.sessionFile) {
        const snapshot = await (
          await context.control()
        ).call({
          type: "read_session_snapshot",
          sessionPath: record.sessionFile,
        });
        if (!isNekSessionSnapshot(snapshot) || snapshot.session.id !== input.id)
          throw new Error("nek returned a mismatched subagent session snapshot");
        entries = snapshot.entries as NekSessionEntry[];
        leafId = snapshot.leafId;
      } else if (live) {
        // 活跃 child 的首轮可能尚未落盘；它与纯内存 child 都由父 registry 提供当前消息。
        const transcript = await owner.service.getSubagentTranscript({ sessionKey, id: input.id });
        entries = (transcript.messages as NekAgentMessage[]).map((message, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index ? `message-${index - 1}` : null,
          timestamp: new Date(message.timestamp).toISOString(),
          message,
        }));
      } else {
        // 历史子代理既没有落盘会话、也早就不在 registry 里：只有被截断的 finalText 还在。
        // 不从 finalText 伪造 provider/model/usage 造一份"看起来完整"的对话。
        throw new Error(`Subagent ${input.id} has no persisted transcript in the parent session`);
      }
      const { rows } = projectEntries({
        sessionId: input.id,
        entries,
        leafId,
        // 子代理还活着时它的持久化孙代理也可能是 running；静止时残留的 running 一律收敛。
        isSessionRunning: record.status === "running",
      });
      const lastTurn = rows.findLast((row) => row.kind === "turnHeader");
      if (lastTurn?.kind === "turnHeader") {
        lastTurn.state =
          record.status === "running"
            ? "running"
            : record.status === "errored"
              ? "failed"
              : record.status === "aborted"
                ? "completedInterrupted"
                : "completedSuccess";
        if (record.status === "running") delete lastTurn.endedAt;
        else if (record.endedAt !== undefined) lastTurn.endedAt = record.endedAt;
      }
      // 不留缓存；仅保留既有事件窗口上限的最新行，省略数由 UI 明确展示。
      return {
        rows: rows.slice(-maxRows),
        totalCount: rows.length,
        status: record.status,
      };
    });
  };
}

/**
 * 从父会话持久化 entries 复原一个历史子代理记录。
 *
 * `sessionRunning: false`：这里查的都是"registry 里已经没有"的子代理，进程退出前残留的
 * running 状态不可能真实存在，收敛成 aborted 后其 sessionFile 才能按已落盘快照读取。
 */
async function restoreSubagentRecord(
  parent: { client: NekRpcClient },
  id: string,
): Promise<NekSubagentRecord | undefined> {
  const { entries } = await parent.client.call({ type: "get_entries" });
  return collectPersistedSubagentRecords(entries, { sessionRunning: false }).get(id)?.record;
}
