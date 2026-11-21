import type {
  NekHistoryStreamEvent,
  NekHistoryStreamOmission,
  NekHistoryStreamState,
} from "@zcode/shared/nek-protocol";
import type { LiveHistoryPreview } from "@zcode/shared/zcode-protocol-v4";

export const LIVE_EVENT_BYTES = 1024 * 1024;
const PREVIEW_BYTES = 32768;
export type DecodedHistoryEvent =
  | {
      type: "event";
      epoch: string;
      eventId: number;
      event: Record<string, unknown>;
      omissions: NekHistoryStreamOmission[];
    }
  | Extract<
      NekHistoryStreamEvent,
      { type: "history_entry_appended" | "history_entry_pending" | "history_stream_reset" }
    >;
export class NekHistoryStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
interface Assembly {
  eventId: number;
  eventType: string;
  omissions: NekHistoryStreamOmission[];
  offset: number;
  chunks: Buffer[];
  preview: Buffer[];
  previewBytes: number;
  oversized: boolean;
}

/** Single event assembly, exact byte offsets, fixed admission/preview bounds. No completed cache. */
export class NekHistoryStreamDecoder {
  private epoch?: string;
  private seq = 0;
  private eventId = 0;
  private assembly?: Assembly;
  private timer?: ReturnType<typeof setTimeout>;
  private failed = false;
  private negotiating = false;
  private readonly retired = new Set<string>();
  constructor(
    private readonly sink: {
      event: (event: DecodedHistoryEvent) => void;
      preview: (preview: LiveHistoryPreview) => void;
      error: (error: Error) => void;
    },
    private readonly chunkTimeoutMs = 30000,
  ) {}

  private retireEpoch(): void {
    if (this.epoch) this.retired.add(this.epoch);
    if (this.retired.size > 16) this.retired.delete(this.retired.values().next().value!);
  }

  begin(): void {
    this.retireEpoch();
    this.clear();
    this.epoch = undefined;
    this.seq = 0;
    this.eventId = 0;
    this.failed = false;
    this.negotiating = true;
  }
  confirm(state: NekHistoryStreamState): void {
    if (
      this.failed ||
      state.version !== 1 ||
      state.maxEventBytes !== LIVE_EVENT_BYTES ||
      state.epoch !== this.epoch
    )
      throw new NekHistoryStreamError(
        "NEGOTIATION",
        "historyStream=1 reset/ack mismatch; update nek and retry",
      );
    this.negotiating = false;
  }
  dispose(): void {
    this.clear();
    this.failed = true;
  }
  fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.clear();
    this.sink.error(error instanceof Error ? error : new Error(String(error)));
  }
  get bufferedBytes(): number {
    return this.assembly?.chunks.reduce((sum, chunk) => sum + chunk.length, 0) ?? 0;
  }
  get isFailed(): boolean {
    return this.failed;
  }

  accept(frame: NekHistoryStreamEvent, expectReplacement = false): void {
    if (this.failed) return;
    try {
      this.consume(frame, expectReplacement);
    } catch (error) {
      this.fail(error);
    }
  }
  private consume(frame: NekHistoryStreamEvent, expectReplacement: boolean): void {
    if (
      frame.version !== 1 ||
      typeof frame.epoch !== "string" ||
      !frame.epoch ||
      frame.epoch.length > 4096
    )
      throw new NekHistoryStreamError("FRAME", "invalid live envelope");
    if (this.retired.has(frame.epoch)) return;
    if (frame.type === "history_stream_reset") {
      if (!this.negotiating && !expectReplacement)
        throw new NekHistoryStreamError(
          "RESET",
          "source owner changed; explicitly renegotiate and refetch history",
        );
      if (frame.seq !== 1 || frame.epoch === this.epoch)
        throw new NekHistoryStreamError("SEQUENCE", "reset must start a new epoch at sequence 1");
      if (expectReplacement) this.retireEpoch();
      this.clear();
      this.epoch = frame.epoch;
      this.seq = 1;
      this.eventId = 0;
      this.sink.event(frame);
      return;
    }
    // An old generation is never relabelled with the replacement epoch.
    if (this.epoch && frame.epoch !== this.epoch) return;
    if (!this.epoch || !Number.isSafeInteger(frame.seq) || frame.seq !== this.seq + 1)
      throw new NekHistoryStreamError(
        "SEQUENCE",
        "live history sequence gap or duplicate; explicitly reload history",
      );
    this.seq = frame.seq;
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") > LIVE_EVENT_BYTES)
      throw new NekHistoryStreamError("FRAME_LIMIT", "live record exceeds negotiated 1 MB");
    if (frame.type === "history_stream_error")
      throw new NekHistoryStreamError(frame.code, frame.message.slice(0, 8192));
    if (frame.type === "history_event_chunk") {
      this.chunk(frame);
      return;
    }
    if (this.assembly)
      throw new NekHistoryStreamError(
        "INTERLEAVED",
        "unfinished event before next semantic record",
      );
    if (frame.type === "history_event" || frame.type === "history_event_start") {
      if (!Number.isSafeInteger(frame.eventId) || frame.eventId !== this.eventId + 1)
        throw new NekHistoryStreamError("EVENT_SEQUENCE", "invalid live event identity");
      this.eventId = frame.eventId;
      this.omissions(frame.omissions);
      if (frame.type === "history_event") {
        this.emit(frame.event, frame.eventId, frame.omissions);
        return;
      }
      if (frame.encoding !== "json-utf8/base64" || typeof frame.eventType !== "string")
        throw new NekHistoryStreamError("ENCODING", "invalid streamed event encoding");
      this.assembly = {
        eventId: frame.eventId,
        eventType: frame.eventType,
        omissions: frame.omissions,
        offset: 0,
        chunks: [],
        preview: [],
        previewBytes: 0,
        oversized: false,
      };
      this.armTimer();
      return;
    }
    this.sink.event(frame);
  }
  private chunk(frame: Extract<NekHistoryStreamEvent, { type: "history_event_chunk" }>): void {
    const a = this.assembly;
    if (!a || frame.eventId !== a.eventId || frame.offset !== a.offset)
      throw new NekHistoryStreamError("OFFSET", "chunk has no matching contiguous event");
    if (frame.final) {
      if (frame.data !== "" || frame.totalBytes !== a.offset)
        throw new NekHistoryStreamError("OFFSET", "invalid final byte count");
      this.clear();
      if (a.oversized) {
        this.sink.preview({
          epoch: this.epoch!,
          eventId: a.eventId,
          eventType: a.eventType,
          preview: new TextDecoder().decode(Buffer.concat(a.preview, a.previewBytes)),
          receivedBytes: a.offset,
          incomplete: true,
        });
        // Applying partial reset/structured progress would be false success. Final persisted bodies
        // remain in the source; explicit renegotiation + bounded refetch resolves their capabilities.
        throw new NekHistoryStreamError(
          "TRANSIENT_LIMIT",
          `incomplete ${a.eventType} preview (${a.offset} bytes); reload persisted history; transient semantics were not applied`,
        );
      }
      const event = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(a.chunks, a.offset)),
      );
      if (event.type !== a.eventType)
        throw new NekHistoryStreamError("EVENT_TYPE", "chunk event type mismatch");
      this.emit(event, a.eventId, a.omissions);
      return;
    }
    if (
      typeof frame.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
    )
      throw new NekHistoryStreamError("ENCODING", "invalid base64 chunk");
    const bytes = Buffer.from(frame.data, "base64");
    if (!bytes.length || bytes.length > 49152)
      throw new NekHistoryStreamError("CHUNK_LIMIT", "invalid chunk size");
    if (!Number.isSafeInteger(a.offset + bytes.length))
      throw new NekHistoryStreamError("OFFSET", "chunk byte count overflow");
    a.offset += bytes.length;
    if (a.previewBytes < PREVIEW_BYTES) {
      const part = bytes.subarray(0, PREVIEW_BYTES - a.previewBytes);
      a.preview.push(Buffer.from(part));
      a.previewBytes += part.length;
    }
    if (a.offset > LIVE_EVENT_BYTES) {
      a.oversized = true;
      a.chunks.length = 0;
    } else a.chunks.push(bytes);
    this.armTimer();
  }
  private emit(
    event: Record<string, unknown>,
    eventId: number,
    omissions: NekHistoryStreamOmission[],
  ): void {
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.type !== "string" ||
      event.type.startsWith("history_") ||
      [
        "response",
        "extension_ui_request",
        "extension_ui_cancel",
        "auth_event",
        "entry_appended",
      ].includes(event.type)
    )
      throw new NekHistoryStreamError("EVENT", "invalid semantic history event/channel");
    this.sink.event({ type: "event", epoch: this.epoch!, eventId, event, omissions });
  }
  private omissions(omissions: NekHistoryStreamOmission[]): void {
    if (
      !Array.isArray(omissions) ||
      omissions.length > 256 ||
      omissions.some(
        (o) =>
          !o ||
          typeof o.pointer !== "string" ||
          o.pointer.length > 4096 ||
          o.resolution !== "history" ||
          !["persisted_body", "redundant_delta"].includes(o.reason),
      )
    )
      throw new NekHistoryStreamError("OMISSIONS", "invalid live omission contract");
  }
  private armTimer(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.fail(
          new NekHistoryStreamError(
            "CHUNK_TIMEOUT",
            "incomplete history event; retry history only",
          ),
        ),
      this.chunkTimeoutMs,
    );
    this.timer.unref?.();
  }
  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.assembly = undefined;
  }
}
