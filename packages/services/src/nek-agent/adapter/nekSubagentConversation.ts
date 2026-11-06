import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import type { NekAgentMessage, NekSessionEntry } from "@zcode/shared/nek-protocol";
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import { projectEntries } from "../projection/nekEntryProjection.js";
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
      const record = result.subagents.find((child) => child.id === input.id);
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
      } else {
        // 活跃 child 的首轮可能尚未落盘；它与纯内存 child 都由父 registry 提供当前消息。
        const transcript = await owner.service.getSubagentTranscript({ sessionKey, id: input.id });
        entries = (transcript.messages as NekAgentMessage[]).map((message, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index ? `message-${index - 1}` : null,
          timestamp: new Date(message.timestamp).toISOString(),
          message,
        }));
      }
      const { rows } = projectEntries({ sessionId: input.id, entries, leafId });
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
