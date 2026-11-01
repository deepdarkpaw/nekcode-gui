import type { NekRpcEvent } from "@zcode/shared/nek-protocol";
import type { TimelineMarkerPayload } from "@zcode/shared/zcode-protocol-v4";
import { buildTimelineMarkerRow } from "./nekRows.js";
import type { NekProjectionStore } from "./nekProjectionStore.js";

type ExtensionError = Extract<NekRpcEvent, { type: "extension_error" }>;
type Notice = Extract<TimelineMarkerPayload, { type: "extensionError" }>["errors"][number];

/** RPC-only errors are not nek entries. Keep one bounded session-local ledger across authoritative refreshes. */
export class NekExtensionErrors {
  private readonly errors: Notice[] = [];
  private createdAt = 0;

  record(event: ExtensionError, at: number): void {
    const notice = {
      extensionPath: event.extensionPath.slice(0, 2048),
      event: event.event.slice(0, 256),
      error: event.error.slice(0, 8192),
      count: 1,
    };
    const index = this.errors.findIndex(
      (item) =>
        item.extensionPath === notice.extensionPath &&
        item.event === notice.event &&
        item.error === notice.error,
    );
    const previous = index < 0 ? undefined : this.errors.splice(index, 1)[0];
    notice.count = Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1);
    this.errors.push(notice);
    if (this.errors.length > 20) this.errors.shift();
    this.createdAt = at;
  }

  project(store: NekProjectionStore, turnId: string): void {
    if (this.errors.length === 0) return;
    const entityId = "nek:extension-errors";
    store.add(
      buildTimelineMarkerRow(
        { entityId, rowId: store.allocate(entityId), turnId, createdAt: this.createdAt },
        { type: "extensionError", errors: [...this.errors] },
        "turnTailBoundary",
      ),
    );
  }
}
