import { CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import type {
  ConversationHistoryTurn,
  V4ConversationHistoryPageResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "../zcode-agent/zcodeAgent.js";
import type { ConversationSharePreflightInput } from "./conversationShare.js";
import { ConversationShareServiceError } from "./conversationShare.js";
import {
  ConversationShareHistoryError,
  ShareHistoryBudget,
} from "./conversationShareHistoryPolicy.js";
import {
  ShareHistoryRows,
  type ConversationShareRowsRead,
} from "./conversationShareHistoryRows.js";
import { readLegacyShareRows } from "./conversationShareLegacyRows.js";

/** Consumer port matches the finalized host API; no runtime optional-member negotiation. */
interface SourceAgent {
  conversationHistoryPageV4(
    input: ZCodeAgentSessionTarget & { beforeCursor?: string; turnLimit?: number },
  ): Promise<V4ConversationHistoryPageResult>;
}
type LegacyAgent = Pick<IZCodeAgentService, "conversationRowsRangeV4">;
export type ConversationShareHistoryReadMode = "source" | "legacy-projection";
function invalid(): never {
  throw new ConversationShareHistoryError("history_invalid_page");
}

/** Only session/workspace identity crosses the source port, never share options or caller capabilities. */
function historyTarget(input: ConversationSharePreflightInput): ZCodeAgentSessionTarget {
  return {
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
    ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
  };
}

/** Every request retains only bounded rows for this explicit selection, never live renderer state. */
async function readSourceRows(
  input: ConversationSharePreflightInput,
  agent: SourceAgent,
  budget: ShareHistoryBudget,
): Promise<ConversationShareRowsRead> {
  if (!input.selection || !["all", "productTurns", "rowAnchors"].includes(input.selection.kind))
    throw new ConversationShareServiceError(
      "invalid_selection",
      "An explicit conversation share selection is required",
    );
  const target = historyTarget(input);
  const rows = new ShareHistoryRows();
  if (input.selection.kind === "rowAnchors")
    throw new ConversationShareHistoryError("history_turn_selection_required");
  if (input.selection.kind === "productTurns") {
    if (
      !input.selection.productTurnIds.length ||
      input.selection.productTurnIds.length > CONVERSATION_ARCHIVE_LIMITS.rows
    )
      throw new ConversationShareServiceError(
        "invalid_selection",
        "A bounded source turn selection is required",
      );
    if (input.selection.productTurnIds.some((id) => typeof id !== "string" || !id))
      throw new ConversationShareServiceError(
        "invalid_selection",
        "A source turn identity is required",
      );
  }

  // Turn IDs are opaque: resolve selections through complete source pages rather than guessing entry IDs.
  const pending =
    input.selection.kind === "productTurns" ? new Set(input.selection.productTurnIds) : undefined;
  let beforeCursor: string | undefined;
  let branchRevision: string | undefined;
  let totalTurns: number | undefined;
  let expectedEnd: number | undefined;
  const seen = new Set<string>();
  while (true) {
    const page: V4ConversationHistoryPageResult = await budget.read(() =>
      agent.conversationHistoryPageV4({
        ...target,
        turnLimit: 20,
        ...(beforeCursor === undefined ? {} : { beforeCursor }),
      }),
    );
    rows.fence(page);
    const history = page.history;
    if (
      !history ||
      typeof history.branchRevision !== "string" ||
      !history.branchRevision ||
      !Number.isSafeInteger(history.totalTurns) ||
      history.totalTurns < 0 ||
      !Array.isArray(history.turns) ||
      history.turns.length > 20 ||
      typeof history.hasOlder !== "boolean" ||
      typeof history.hasNewer !== "boolean"
    )
      invalid();
    if (history.totalTurns > CONVERSATION_ARCHIVE_LIMITS.rows)
      throw new ConversationShareHistoryError("history_budget_exceeded");
    if (
      (branchRevision !== undefined && branchRevision !== history.branchRevision) ||
      (totalTurns !== undefined && totalTurns !== history.totalTurns)
    )
      throw new ConversationShareHistoryError("history_stale");
    branchRevision = history.branchRevision;
    totalTurns = history.totalTurns;
    const end: number = expectedEnd ?? history.totalTurns;
    if (history.turns.length === 0 && (end !== 0 || page.rows.length !== 0)) invalid();
    const start = history.turns[0]?.position ?? 0;
    if (
      (history.turns.at(-1)?.position ?? -1) !== end - 1 ||
      history.hasOlder !== start > 0 ||
      history.hasNewer !== end < history.totalTurns
    )
      invalid();
    const selected = new Set<string>();
    for (const [index, turn] of history.turns.entries()) {
      if (turn.position !== start + index) invalid();
      if (pending && !pending.has(turn.turnId)) continue;
      rows.turn(turn);
      selected.add(turn.turnId);
      pending?.delete(turn.turnId);
    }
    // Validate every returned owner before retaining only the explicitly selected turns.
    const owners = new Set(history.turns.map((turn: ConversationHistoryTurn) => turn.turnId));
    if (!Array.isArray(page.rows) || page.rows.some((row) => !owners.has(row.turnId))) invalid();
    if (page.rows.length > CONVERSATION_ARCHIVE_LIMITS.rows)
      throw new ConversationShareHistoryError("history_budget_exceeded");
    rows.add(
      page.rows.filter((row) => selected.has(row.turnId)),
      selected,
    );
    if (pending?.size === 0 || !history.hasOlder) break;
    if (
      typeof history.olderCursor !== "string" ||
      !history.olderCursor ||
      seen.has(history.olderCursor)
    )
      invalid();
    seen.add(history.olderCursor);
    beforeCursor = history.olderCursor;
    expectedEnd = start;
  }
  if (pending?.size)
    throw new ConversationShareServiceError("invalid_selection", "Unknown source turn selection");
  return rows.finish();
}

/** Source mode is the production default; legacy projection is an explicit, separate owner contract. */
export class ConversationShareHistoryReader {
  private active = 0;

  async read(
    input: ConversationSharePreflightInput,
    agent: LegacyAgent,
    mode: ConversationShareHistoryReadMode,
  ): Promise<ConversationShareRowsRead> {
    if (this.active >= 2)
      throw new ConversationShareServiceError(
        "operation_busy",
        "Conversation source history collection is busy",
      );
    this.active++;
    const budget = new ShareHistoryBudget();
    try {
      // The production assembly already passes the complete local/remote/scoped agent. Keeping
      // its historical narrow artifact type does not imply capability probing or a fallback.
      const result =
        mode === "legacy-projection"
          ? await readLegacyShareRows(historyTarget(input), agent, budget)
          : await readSourceRows(input, agent as LegacyAgent & SourceAgent, budget);
      budget.check();
      return result;
    } finally {
      budget.finish();
      this.active--;
    }
  }
}
