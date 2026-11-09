import type { NekRpcEvent } from "@zcode/shared/nek-protocol";
import type { NekProcessPoolEvent } from "../nekProcessPool.js";
import { NekPendingInputCancelledError } from "./nekPendingInputQueue.js";
import type { NekSessionPhase, NekSessionRecord } from "./types.js";

/**
 * nek 事件 → 会话状态机的映射（phase、流式/压缩事实、GUI 待发送输入的收口）。
 *
 * 只做状态转移，不碰投影器与订阅广播：这两件事由 runtime 基类按固定顺序接着做
 * （先状态、再投影、最后广播），保证实时事件与快照重建读到同一份事实。
 */
interface NekSessionEventTarget {
  record: NekSessionRecord;
  /** 推进生命周期世代：异步快照据此判定自己是否已经过时。 */
  bumpStateEpoch: (record: NekSessionRecord) => void;
  setPhase: (record: NekSessionRecord, phase: NekSessionPhase) => void;
  beginTurn: (sessionKey: string) => void;
  endTurn: (sessionKey: string) => void;
  settlePendingInputs: (record: NekSessionRecord) => void;
  cancelPendingInputs: (record: NekSessionRecord, reason: Error) => void;
  /** `agent_settled` 后用 get_state 校准事实（失败只记日志，不改状态）。 */
  refreshSnapshot: (record: NekSessionRecord) => void;
}

/** 会改变"能否接纳输入 / 是否在跑"的事件：必须推进生命周期世代。 */
const NEK_LIFECYCLE_EVENTS = new Set<NekRpcEvent["type"]>([
  "agent_start",
  "agent_settled",
  "compaction_start",
  "compaction_end",
]);

/** 压缩事件是权威事实：到达后预约交接给它，之后只看 `state.isCompacting`。 */
function applySessionState(record: NekSessionRecord, event: NekRpcEvent): void {
  if (record.state) {
    if (event.type === "agent_start" || event.type === "agent_settled")
      record.state = { ...record.state, isStreaming: event.type === "agent_start" };
    if (event.type === "compaction_start" || event.type === "compaction_end")
      record.state = {
        ...record.state,
        /** willRetry resumes the original model request after compaction; the compaction lease has ended. */
        isCompacting: event.type === "compaction_start",
      };
  }
  if (event.type === "compaction_start" || event.type === "compaction_end")
    record.compactReserved = false;
}

export function applyNekSessionEvent(input: NekSessionEventTarget, event: NekRpcEvent): void {
  const { record } = input;
  if (NEK_LIFECYCLE_EVENTS.has(event.type)) input.bumpStateEpoch(record);
  applySessionState(record, event);
  switch (event.type) {
    case "agent_start":
      input.beginTurn(record.key);
      input.setPhase(record, "running");
      return;
    case "compaction_start":
      input.setPhase(record, "running");
      return;
    case "compaction_end":
      if (!record.state?.isCompacting)
        input.setPhase(record, record.state?.isStreaming ? "running" : "idle");
      // 用户取消压缩：待发送输入可见失败（草稿回到输入框），不能在取消之后补发。
      if (event.aborted)
        input.cancelPendingInputs(
          record,
          new NekPendingInputCancelledError("压缩已取消，消息没有发送；草稿已保留，可重试"),
        );
      else input.settlePendingInputs(record);
      return;
    case "agent_settled":
      input.endTurn(record.key);
      // 压缩跨过 agent_settled：中断旧 run 的收口事件不能把压缩状态一起清掉。
      input.setPhase(record, record.state?.isCompacting ? "running" : "idle");
      input.refreshSnapshot(record);
      return;
    case "extension_ui_request":
      if (
        event.method === "structured" ||
        ["select", "confirm", "input", "editor"].includes(event.method)
      )
        input.setPhase(record, "waiting_input");
      return;
    case "extension_ui_cancel":
      if (record.phase === "waiting_input")
        input.setPhase(
          record,
          record.state?.isStreaming || record.state?.isCompacting ? "running" : "idle",
        );
      return;
    default:
      return;
  }
}

/**
 * 池回收事件：空闲/容量回收是安静断开，下次使用时重连；
 * `dispose` / `crashed` 则不是安静回收，待发送输入必须可见失败。
 */
export function applyNekPoolReclaim(input: {
  event: NekProcessPoolEvent;
  record: NekSessionRecord | undefined;
  detachProcess: (record: NekSessionRecord) => void;
  setPhase: (record: NekSessionRecord, phase: NekSessionPhase) => void;
  cancelPendingInputs: (record: NekSessionRecord, reason: Error) => void;
}): void {
  if (input.event.type !== "session_reclaimed" || !input.record) return;
  if (input.event.reason === "dispose" || input.event.reason === "crashed") {
    input.cancelPendingInputs(
      input.record,
      new NekPendingInputCancelledError("nek 进程已结束，消息没有发送；草稿已保留，可重试"),
    );
    return;
  }
  input.detachProcess(input.record);
  input.setPhase(input.record, "idle");
}
