import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationShareService } from "../src/conversation-share/conversationShareService.js";
import { decodeConversationArchive } from "../src/conversation-share/conversationArchive.js";

export const target = {
  workspacePath: "/isolated/share",
  workspaceIdentity: "workspace-share",
  sessionId: "session-share",
};
const watermark = { atSeq: 7, atRevision: 3, atLogEpoch: "epoch-share" };
export const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
export const turnId = (position: number) => `turn:u${position + 1}`;

/** Complete v4 rows for an ordinary persisted 70-user-turn conversation, not a tail-only stub. */
export function historyFixture(total = 70) {
  const turns = Array.from({ length: total }, (_, position) => ({
    turnId: turnId(position),
    userEntryId: `u${position + 1}`,
    position,
    preview: `Question ${position + 1}`,
  }));
  const rows: ConversationRow[] = turns.flatMap((turn) => {
    const base = {
      turnId: turn.turnId,
      productTurnId: turn.turnId,
      createdAt: turn.position + 1,
      createdAtSeq: turn.position * 16 + 1,
    };
    return [
      {
        ...base,
        rowId: turn.position * 16 + 1,
        entityId: `header:${turn.turnId}`,
        kind: "turnHeader" as const,
        origin: "userInput" as const,
        state: "completedSuccess" as const,
        startedAt: turn.position + 1,
      },
      {
        ...base,
        rowId: turn.position * 16 + 2,
        entityId: `entry:${turn.userEntryId}`,
        kind: "userInput" as const,
        origin: "realUser" as const,
        text: turn.preview,
      },
      {
        ...base,
        rowId: turn.position * 16 + 3,
        entityId: `entry:a${turn.position + 1}`,
        kind: "assistantText" as const,
        state: "complete" as const,
        text: `Answer ${turn.position + 1}`,
      },
    ];
  });
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const agent = {
    conversationHistoryPageV4: async (input: Record<string, unknown>) => {
      calls.push({ method: "page", input });
      const end = input.beforeCursor
        ? Number(String(input.beforeCursor).replace("older:", ""))
        : total;
      const start = Math.max(0, end - 20);
      return {
        ...watermark,
        rows: rows.filter((row) =>
          turns.slice(start, end).some((turn) => row.turnId === turn.turnId),
        ),
        history: {
          branchRevision: "branch-share",
          totalTurns: total,
          turns: turns.slice(start, end),
          hasOlder: start > 0,
          hasNewer: end < total,
          ...(start > 0 ? { olderCursor: `older:${start}` } : {}),
          ...(end < total ? { newerCursor: `newer:${end}` } : {}),
        },
      };
    },
    conversationHistoryTurnV4: async (input: Record<string, unknown>) => {
      calls.push({ method: "turn", input });
      const turn = turns.find((turn) => turn.turnId === input.turnId);
      if (!turn) throw new Error("unknown source turn");
      return {
        ...watermark,
        rows: rows.filter((row) => row.turnId === turn.turnId),
        turn,
        hasMore: false,
      };
    },
    conversationHistoryDirectoryV4: async (input: Record<string, unknown>) => {
      calls.push({ method: "directory", input });
      throw new Error("Selected source turn IDs never require a whole-history directory scan");
    },
    conversationHistoryContentV4: async (input: Record<string, unknown>) => {
      calls.push({ method: "content", input });
      throw new Error("Source entry pointers are not v4 row hydration pointers");
    },
    conversationRowsRangeV4: async (input: Record<string, unknown>) => {
      calls.push({ method: "legacy", input });
      return {
        ...watermark,
        rows: rows.filter((row) => turns.slice(-20).some((turn) => row.turnId === turn.turnId)),
        hasMore: false,
      };
    },
    conversationFileChangesV4: async () => {
      throw new Error("No file changes in text fixture");
    },
    conversationAttachmentReadV4: async () => {
      throw new Error("No attachments in text fixture");
    },
    conversationAttachmentStatV4: async () => {
      throw new Error("No attachments in text fixture");
    },
  };
  const artifactSource = {
    read: async () => {
      throw new Error("No artifacts in text fixture");
    },
  };
  const service = new ConversationShareService({
    zcodeAgentService: agent,
    artifactSource,
    logger: quietLogger,
  });
  return { turns, rows, calls, agent, artifactSource, service };
}

export async function exportedRows(
  service: Pick<ConversationShareService, "publish" | "readExportChunk" | "releaseExport">,
  selection: { kind: "all" } | { kind: "productTurns"; productTurnIds: string[] },
) {
  const result = await service.publish(
    { ...target, selection, title: "Isolated history", clientRequestId: "request-share" },
    "operation-share",
  );
  try {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < result.byteLength; ) {
      const chunk = Buffer.from(await service.readExportChunk(result.archiveId, offset), "base64");
      if (!chunk.length) throw new Error("Export chunk did not advance");
      chunks.push(chunk);
      offset += chunk.length;
    }
    return (await decodeConversationArchive(Buffer.concat(chunks))).content;
  } finally {
    await service.releaseExport(result.archiveId);
  }
}
