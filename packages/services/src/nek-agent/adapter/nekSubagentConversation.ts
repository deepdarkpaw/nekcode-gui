import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import { historyMetadata, projectHistory } from "../projection/nekHistoryProjection.js";
import { verifyHistorySpawnAnchors } from "../service/nekHistoryAnchors.js";
import { boundHistoryResult } from "../service/nekHistoryRpc.js";
import type { NekAgentServiceAdapterLegacyTarget } from "./nekAgentServiceAdapterLegacySupport.js";

/** Parent relation is checked before every bounded child read. Never resume a child or read raw transcript JSON. */
export function createNekSubagentConversationReader(
  owner: NekAgentServiceAdapterLegacyTarget,
  _maxRows?: number,
): IZCodeAgentService["getSubagentConversation"] {
  return async (input) => {
    const { sessionKey } = await owner.ensureNekSessionBinding(input, input.sessionId);
    return await owner.service.runHistoryRead(sessionKey, input.id, async (context) => {
      const { beforeCursor, afterCursor, aroundEntryId, turnLimit = 20 } = input;
      const page = await context.read({
        type: "read_history_page",
        beforeCursor,
        afterCursor,
        aroundEntryId,
        turnLimit,
      });
      const scope = `${page.sessionId}\0${page.branchRevision}`;
      const anchors = context.projector.historyAnchors(scope);
      await verifyHistorySpawnAnchors(
        page.entries,
        (subagentId) => context.read({ type: "read_history_subagent", subagentId }),
        anchors,
      );
      const record = context.child!;
      const status = record.status;
      if (
        status !== "running" &&
        status !== "completed" &&
        status !== "errored" &&
        status !== "aborted"
      )
        throw new Error("nek child history has no authoritative status");
      const rows = projectHistory({
        sessionId: page.sessionId,
        turns: page.turns,
        entries: page.entries,
        seed: page.seed,
        anchors,
      });
      const last = rows.findLast((row) => row.kind === "turnHeader");
      if (last?.kind === "turnHeader")
        last.state =
          status === "running"
            ? "running"
            : status === "errored"
              ? "failed"
              : status === "aborted"
                ? "completedInterrupted"
                : "completedSuccess";
      const result = boundHistoryResult({
        rows,
        history: historyMetadata(page),
        totalCount: rows.length,
        status,
      } satisfies Awaited<ReturnType<IZCodeAgentService["getSubagentConversation"]>>);
      context.projector.rememberHistoryAnchors(
        scope,
        `${page.branchRevision}:${page.entries[0]?.position}:${page.entries.at(-1)?.position}`,
        rows,
      );
      return result;
    });
  };
}
