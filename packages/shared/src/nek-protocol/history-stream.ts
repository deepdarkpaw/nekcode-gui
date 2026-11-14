/** Mirror of nek gui/history-stream-protocol.ts; independent of persisted page watermarks. */
export type NekHistoryStreamCommand = { id?: string; type: "set_history_stream"; version: 0 | 1 };
export interface NekHistoryStreamState {
  version: 0 | 1;
  epoch: string;
  maxEventBytes: 1048576;
}
export interface NekHistoryStreamOmission {
  pointer: string;
  resolution: "history";
  reason: "persisted_body" | "redundant_delta";
}
interface NekHistoryStreamFrame {
  version: 1;
  epoch: string;
  seq: number;
}
export type NekHistoryStreamEvent =
  | (NekHistoryStreamFrame & {
      type: "history_event";
      eventId: number;
      event: Record<string, unknown>;
      omissions: NekHistoryStreamOmission[];
    })
  | (NekHistoryStreamFrame & {
      type: "history_event_start";
      eventId: number;
      eventType: string;
      encoding: "json-utf8/base64";
      omissions: NekHistoryStreamOmission[];
    })
  | (NekHistoryStreamFrame & {
      type: "history_event_chunk";
      eventId: number;
      offset: number;
      data: string;
      final: false;
    })
  | (NekHistoryStreamFrame & {
      type: "history_event_chunk";
      eventId: number;
      offset: number;
      data: "";
      final: true;
      totalBytes: number;
    })
  | (NekHistoryStreamFrame & {
      type: "history_entry_appended";
      sessionPath: string;
      sessionId: string;
      entryId: string;
      leafId: string | null;
      ref: { command: "read_history_page"; sessionPath: string; aroundEntryId: string };
    })
  | (NekHistoryStreamFrame & {
      type: "history_entry_pending";
      sessionPath?: string;
      sessionId: string;
      entryId: string;
    })
  | (NekHistoryStreamFrame & {
      type: "history_stream_reset";
      sessionPath?: string;
      sessionId: string;
    })
  | (NekHistoryStreamFrame & {
      type: "history_stream_error";
      code: "STREAM_LIMIT" | "STORAGE_ERROR" | "ENCODING_ERROR";
      message: string;
    });
