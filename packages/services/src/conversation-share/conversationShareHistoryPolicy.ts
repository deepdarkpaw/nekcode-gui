import { CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationShareServiceError } from "./conversationShare.js";

type ShareHistoryFailure =
  | "history_invalid_page"
  | "history_stale"
  | "history_budget_exceeded"
  | "history_timeout"
  | "history_turn_selection_required";

/** Typed, RPC-safe blocking error. field carries only a fixed code, never a cursor/ref/path/body. */
export class ConversationShareHistoryError extends ConversationShareServiceError {
  constructor(readonly historyCode: ShareHistoryFailure) {
    const limit = historyCode === "history_budget_exceeded";
    super(
      limit
        ? "limit_exceeded"
        : historyCode === "history_turn_selection_required"
          ? "invalid_selection"
          : "invalid_conversation",
      historyCode === "history_timeout"
        ? "Conversation source history read timed out; retry the export"
        : `Conversation source history cannot be exported: ${historyCode}`,
      {
        reasonCode: limit
          ? "payload_limit"
          : historyCode === "history_stale"
            ? "stale_conversation"
            : "invalid_conversation",
        diagnostics: { phase: "collecting", field: historyCode },
      },
    );
    this.name = "ConversationShareHistoryError";
  }
}

const PRIVATE_HISTORY_KEYS = new Set([
  "history",
  "branchRevision",
  "beforeCursor",
  "afterCursor",
  "olderCursor",
  "newerCursor",
  "nextCursor",
  "cursor",
  "aroundEntryId",
  "sessionPath",
]);

/**
 * Remove host history metadata at its RowBase boundary before allow-list validation.
 * Tool input/body JSON is selected user content: do not silently rewrite a legitimate `history`
 * or `cursor` argument there. Existing URL/reference checks still validate those public fields.
 */
export function stripShareHistoryCapabilities(row: ConversationRow): ConversationRow {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !PRIVATE_HISTORY_KEYS.has(key)),
  ) as ConversationRow;
}

/** One collecting budget spans all complete-turn source pages, not a new timeout per page. */
export class ShareHistoryBudget {
  private readonly deadline = Date.now() + DEFAULT_GUI_RUNTIME_CONFIG.timeouts.commandMs;
  private readonly controller = new AbortController();
  private readonly timer = setTimeout(
    () => this.controller.abort(new ConversationShareHistoryError("history_timeout")),
    DEFAULT_GUI_RUNTIME_CONFIG.timeouts.commandMs,
  );
  private requests = 0;
  private bytes = 0;

  check(): void {
    this.controller.signal.throwIfAborted();
    if (Date.now() >= this.deadline) throw new ConversationShareHistoryError("history_timeout");
  }

  async read<T>(run: () => Promise<T>): Promise<T> {
    this.check();
    if (++this.requests > CONVERSATION_ARCHIVE_LIMITS.rows)
      throw new ConversationShareHistoryError("history_budget_exceeded");
    const signal = this.controller.signal;
    const result = await new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          this.check();
          return run();
        })
        .then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    });
    this.check();
    // Bound transferred source data as well as retained rows. Repeated header/metadata traffic
    // is not free, even when stable identity deduplication keeps the final row count small.
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(result);
    } catch {
      throw new ConversationShareHistoryError("history_invalid_page");
    }
    if (encoded === undefined) throw new ConversationShareHistoryError("history_invalid_page");
    this.bytes += Buffer.byteLength(encoded);
    if (this.bytes > CONVERSATION_ARCHIVE_LIMITS.manifestBytes)
      throw new ConversationShareHistoryError("history_budget_exceeded");
    this.check();
    return result;
  }

  finish(): void {
    clearTimeout(this.timer);
  }
}
