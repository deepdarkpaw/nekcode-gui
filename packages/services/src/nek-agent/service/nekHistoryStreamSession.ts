import type { NekHistoryStreamEvent, NekRpcEvent } from "@zcode/shared/nek-protocol";
import {
  NekHistoryStreamDecoder,
  NekHistoryStreamError,
  type DecodedHistoryEvent,
} from "../nekHistoryStreamDecoder.js";
import type { NekRpcProcess } from "../nekRpcProcess.js";
import type { NekSessionRecord } from "./types.js";
import {
  historyResult,
  HISTORY_RPC_MAX_BYTES,
  HISTORY_PAGE_MAX_BYTES,
  requireHistoryPages,
} from "./nekHistoryRpc.js";

/** Input is admitted only with coherent writable history; explicit stop/abort has no such gate. */
export function assertNekHistoryInputReady(record: NekSessionRecord): void {
  if (!record.readonly && !record.historyStream?.active)
    throw new Error(
      "nek live history is unavailable; retry history synchronization before sending new input",
    );
}

/** Attach exactly one transport owner to the existing process record. */
export function attachNekHistoryStream(
  record: NekSessionRecord,
  process: NekRpcProcess,
  route: (event: NekRpcEvent, project?: () => void) => void,
): void {
  record.projector?.resetHistoryProcessSeeds();
  record.readonly = false;
  const stream = new NekHistoryStreamSession(record, process, route);
  record.historyStream = stream;
  record.detachEvents = process.client.onAnyEvent((event) => stream.accept(event));
}

/** Bootstrap/recovery wraps the existing source loader, never a second snapshot implementation. */
export async function loadNekHistoryStream(
  record: NekSessionRecord,
  load: () => Promise<void>,
): Promise<void> {
  const stream = record.historyStream;
  const repairing = stream?.failed;
  try {
    if (repairing) {
      await stream.negotiate();
      await stream.requireRecoveryBoundary();
    } else await stream?.pause();
    await load();
    stream?.resume();
  } catch (error) {
    stream?.fail(error);
    throw error;
  }
}

/** Process lease owns transport order only; accepted rows and source watermarks live in the projector. */
export class NekHistoryStreamSession {
  private readonly decoder: NekHistoryStreamDecoder;
  private readonly queue: Array<{ event: DecodedHistoryEvent; bytes: number }> = [];
  private queuedBytes = 0;
  private generation = 0;
  private ready = false;
  private disposed = false;
  private pumping?: Promise<void>;
  private negotiating?: Promise<void>;
  private recovery?: Promise<void>;
  private boundaryDirty = false;
  private readonly seen = new Set<string>();
  private reads = new AbortController();
  private readonly detachDisconnect: () => void;
  constructor(
    private readonly record: NekSessionRecord,
    private readonly process: NekRpcProcess,
    private readonly route: (event: NekRpcEvent, project?: () => void) => void,
  ) {
    this.decoder = new NekHistoryStreamDecoder({
      event: (event) => this.enqueue(event),
      preview: (preview) => record.projector?.applyHistoryPreview(preview),
      error: (error) => {
        this.generation += 1;
        this.reads.abort(error);
        this.clearQueue();
        record.historyGeneration = (record.historyGeneration ?? 0) + 1;
        record.projector?.reportHistoryFailure(error);
      },
    });
    this.detachDisconnect = process.client.onExit(() => {
      if (!record.closing && process.client.state === "open")
        this.fail(
          new NekHistoryStreamError(
            "DISCONNECTED",
            "history transport disconnected; explicitly reconnect and refetch bounded history",
          ),
        );
    });
  }
  get failed(): boolean {
    return this.decoder.isFailed;
  }
  fail(error: unknown): void {
    this.decoder.fail(error);
  }
  get active(): boolean {
    return this.ready && !this.failed && !this.disposed;
  }
  async recover(load: () => Promise<void>): Promise<void> {
    if (this.recovery) return await this.recovery;
    if (!this.failed) return;
    const flight = load();
    this.recovery = flight;
    try {
      await flight;
    } finally {
      if (this.recovery === flight) this.recovery = undefined;
    }
  }
  async negotiate(): Promise<void> {
    if (this.negotiating) return await this.negotiating;
    const flight = this.negotiateOnce();
    this.negotiating = flight;
    try {
      await flight;
    } finally {
      if (this.negotiating === flight) this.negotiating = undefined;
    }
  }
  private async negotiateOnce(): Promise<void> {
    requireHistoryPages(this.process.guiInfo);
    if (this.process.guiInfo.capabilities?.historyStream !== 1)
      throw new NekHistoryStreamError(
        "UPDATE_REQUIRED",
        "nek historyStream=1 is required for writable sessions; update nek on the execution target (including Remote SSH)",
      );
    this.ready = false;
    this.generation += 1;
    this.clearQueue();
    this.reads.abort(new Error("history stream renegotiated"));
    this.reads = new AbortController();
    this.seen.clear();
    this.decoder.begin();
    try {
      const state = await this.process.client.call({ type: "set_history_stream", version: 1 });
      this.assertOwner();
      this.decoder.confirm(state);
    } catch (error) {
      this.decoder.fail(error);
      throw error;
    }
  }
  /**
   * A reload must read its page after every applied locator, or an older page would rewind the
   * observed source past entries already marked seen. Later frames stay queued until resume().
   */
  async pause(): Promise<void> {
    this.ready = false;
    await this.drain();
  }
  /** Bootstrap/resync is the only full bounded load; queued facts then resume in wire order. */
  resume(): void {
    this.assertOwner();
    this.ready = true;
    this.record.projector?.applyHistoryPreview(null);
    this.pump();
  }
  accept(event: NekRpcEvent): void {
    if (event.type.startsWith("history_")) {
      this.decoder.accept(event as NekHistoryStreamEvent);
      return;
    }
    if (["extension_ui_request", "extension_ui_cancel", "auth_event"].includes(event.type)) {
      this.route(event);
      return;
    }
    // Before negotiation legacy startup facts may exist, but no body is admitted into live history.
    if (this.ready)
      this.decoder.fail(
        new NekHistoryStreamError(
          "LEGACY_EVENT",
          "unnegotiated legacy event after historyStream ACK",
        ),
      );
  }
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.reads.abort(new Error("history process retired"));
    this.decoder.dispose();
    this.detachDisconnect();
    this.clearQueue();
  }
  async drain(): Promise<void> {
    while (this.pumping) await this.pumping;
  }
  /** Lost semantics cannot be paired across an ongoing response without producer entry IDs. */
  async requireRecoveryBoundary(): Promise<void> {
    const state = await this.process.client.call(
      { type: "get_state" },
      { signal: this.reads.signal },
    );
    this.assertOwner();
    if (state.isStreaming || state.isCompacting)
      throw new NekHistoryStreamError(
        "RECOVERY_ACTIVE",
        "history transport lost semantic events; the model/compaction is still running unchanged; explicitly retry history after it settles (no input was replayed)",
      );
  }
  async refreshState(): Promise<void> {
    const generation = this.generation;
    try {
      await this.readState();
    } catch (error) {
      if (generation === this.generation) this.decoder.fail(error);
    }
  }
  private async readState(): Promise<void> {
    const epoch = this.record.stateEpoch;
    const generation = this.generation;
    const [state, stats] = await Promise.all([
      this.process.client.call({ type: "get_state" }, { signal: this.reads.signal }),
      this.process.client.call({ type: "get_session_stats" }, { signal: this.reads.signal }),
    ]);
    if (!this.current(generation) || this.record.stateEpoch !== epoch) return;
    this.record.state = state;
    this.record.projector?.applySessionState(state, stats);
    await this.refreshBoundary();
  }
  async refreshBoundary(): Promise<void> {
    if (!this.active || !this.boundaryDirty) return;
    const generation = this.generation;
    const result = historyResult(
      await this.process.client.call(
        {
          type: "read_history_page",
          view: "summary",
          turnLimit: 20,
          maxBytes: HISTORY_RPC_MAX_BYTES,
        },
        { signal: this.reads.signal },
      ),
    );
    if (!this.current(generation)) return;
    if (
      result.view !== "summary" ||
      "entries" in result ||
      result.sessionId !== this.record.sessionId
    )
      throw new NekHistoryStreamError(
        "SUMMARY",
        "CLI must return metadata-only history summary; update nek",
      );
    this.boundaryDirty = !this.record.projector!.applyHistorySummary(result);
  }
  private enqueue(event: DecodedHistoryEvent): void {
    if (event.type === "history_stream_reset") {
      this.generation += 1;
      this.clearQueue();
      this.record.historyGeneration = (this.record.historyGeneration ?? 0) + 1;
      this.record.projector?.resetHistoryStreamSeeds();
      return;
    }
    if (
      event.type === "history_entry_appended" &&
      (this.seen.has(event.entryId) ||
        this.queue.some(
          (item) =>
            item.event.type === "history_entry_appended" && item.event.entryId === event.entryId,
        ))
    )
      return;
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (this.queue.length >= 64 || this.queuedBytes + bytes > 2 * HISTORY_RPC_MAX_BYTES)
      throw new NekHistoryStreamError(
        "QUEUE_LIMIT",
        "live projection backlog exceeds bounded admission; explicitly reload history",
      );
    this.queue.push({ event, bytes });
    this.queuedBytes += bytes;
    this.pump();
  }
  private pump(): void {
    if (!this.active || this.pumping) return;
    const generation = this.generation;
    this.pumping = this.run(generation)
      .catch((error) => {
        if (generation === this.generation) this.decoder.fail(error);
      })
      .finally(() => {
        this.pumping = undefined;
        if (this.active && this.queue.length) this.pump();
      });
  }
  private async run(generation: number): Promise<void> {
    while (this.current(generation) && this.queue.length) {
      const next = this.queue.shift()!;
      this.queuedBytes -= next.bytes;
      const event = next.event;
      if (event.type === "event") {
        const semantic = event.event as unknown as NekRpcEvent;
        this.route(semantic, () =>
          this.record.projector!.handleHistoryEvent(
            event.event,
            event.omissions,
            `live:${event.epoch}:${event.eventId}`,
          ),
        );
      } else if (event.type === "history_entry_appended") {
        if (
          event.sessionId !== this.record.sessionId ||
          (this.record.path && event.sessionPath !== this.record.path) ||
          event.ref.command !== "read_history_page" ||
          event.ref.sessionPath !== event.sessionPath ||
          event.ref.aroundEntryId !== event.entryId
        )
          throw new NekHistoryStreamError("LOCATOR", "foreign or malformed persisted locator");
        if (this.seen.has(event.entryId)) continue;
        const page = historyResult(
          await this.process.client.call(
            {
              type: "read_history_page",
              view: "target",
              aroundEntryId: event.entryId,
              turnLimit: 1,
              maxBytes: HISTORY_PAGE_MAX_BYTES,
            },
            { signal: this.reads.signal },
          ),
        );
        if (!this.current(generation)) return;
        if (page.view !== "target" || page.sessionId !== this.record.sessionId)
          throw new NekHistoryStreamError(
            "LOCATOR",
            "CLI must return a target page for this session; update nek",
          );
        this.record.projector!.applyHistoryTarget(page, event.entryId);
        this.seen.add(event.entryId);
        if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
        this.boundaryDirty = true;
      }
    }
    if (this.current(generation)) {
      await this.refreshBoundary();
      this.record.projector!.flushNow();
    }
  }
  private current(generation: number): boolean {
    return (
      generation === this.generation &&
      this.active &&
      this.record.process === this.process &&
      !this.record.closing
    );
  }
  private assertOwner(): void {
    if (this.disposed || this.record.closing || this.record.process !== this.process)
      throw new NekHistoryStreamError("OWNER", "live history process retired; retry");
  }
  private clearQueue(): void {
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.boundaryDirty = false;
  }
}
