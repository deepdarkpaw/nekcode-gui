/**
 * historyStream=1 假生产端：协商 reset-before-ACK，之后按 epoch/seq/eventId 封装语义事件。
 *
 * 与 `nekSessionHarness.ts` 中的进程替身保持同一套协议事实：能力位、重置帧先行、
 * 事件编号单调递增；直接通道（auth / 扩展 UI）与 `history_*` 帧原样透传。
 */
import type { NekGuiInfo, NekHistoryStreamState } from "@zcode/shared/nek-protocol";

/** 只有真正实现协商与封装的生产者才宣告 historyStream=1。 */
export const historyStreamCapabilities = {
  historyPages: 2,
  historyStream: 1,
} as const satisfies NekGuiInfo["capabilities"];

/** 这些通道不进历史流：与 nek 的直接路由一致。 */
const DIRECT_EVENT_TYPES = new Set(["auth_event", "extension_ui_request", "extension_ui_cancel"]);

interface HistoryStreamFixture {
  /**
   * 应答 `set_history_stream`：先写重置帧，再返回 ACK。
   * 调用方必须在写出 ACK 之前调用它（重置帧先于响应）。
   */
  negotiate(): NekHistoryStreamState;
  /** 写出一条语义事件；协商完成后自动封装成有序的 history_event 帧。 */
  emit(record: Record<string, unknown>): void;
}

/**
 * @param write 写出单条 JSONL 记录（进程 stdout）
 * @param session 会话身份；重置帧必须报出真实的会话与文件
 */
export function createHistoryStream(
  write: (record: unknown) => void,
  session: { sessionId: string; sessionPath?: string },
): HistoryStreamFixture {
  let epoch: string | undefined;
  let generation = 0;
  let seq = 0;
  let eventId = 0;
  return {
    negotiate() {
      epoch = `fixture:${++generation}`;
      seq = 1;
      eventId = 0;
      write({
        type: "history_stream_reset",
        version: 1,
        epoch,
        seq,
        sessionId: session.sessionId,
        ...(session.sessionPath ? { sessionPath: session.sessionPath } : {}),
      });
      // 协议常量：内核解码器要求 ACK 与 1 MB 帧上限一致，不一致会显式失败。
      return { version: 1, epoch, maxEventBytes: 1048576 };
    },
    emit(record) {
      if (!epoch || DIRECT_EVENT_TYPES.has(String(record.type))) return write(record);
      if (String(record.type).startsWith("history_")) return write(record);
      write({
        type: "history_event",
        version: 1,
        epoch,
        seq: ++seq,
        eventId: ++eventId,
        event: record,
        omissions: [],
      });
    },
  };
}
