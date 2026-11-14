import { vi } from "vitest";
import type {
  ConversationRow,
  V4ConversationHistoryDirectoryResult,
  V4ConversationHistoryPageResult,
  V4ConversationHistoryTurnResult,
  V4ConversationHistoryContentResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { SubagentConversation } from "./useSubagentConversation.js";
import type { SubagentHistoryScope } from "./subagentHistoryTypes.js";

export const scope: SubagentHistoryScope = {
  workspacePath: "/trusted",
  workspaceIdentity: "ssh:trusted",
  remoteSessionId: "remote",
  rootSessionId: "root",
  parentSessionId: "authorizing-parent",
  childSessionId: "child",
};
export const watermark = { atSeq: 1, atRevision: 1, atLogEpoch: "epoch" };
export function childRow(position: number, text = `answer ${position}`): ConversationRow {
  return {
    kind: "assistantText",
    rowId: position * 10 + 1,
    entityId: `answer:${position}`,
    turnId: `turn:${position}`,
    createdAt: 1,
    createdAtSeq: 1,
    text,
    state: "complete",
  };
}
export function childPage(start = 50, end = 70, total = 70): V4ConversationHistoryPageResult {
  const turns = Array.from({ length: end - start }, (_, n) => ({
    turnId: `turn:${start + n}`,
    userEntryId: `entry:${start + n}`,
    position: start + n,
    preview: "question",
  }));
  return {
    ...watermark,
    rows: turns.map((turn) => childRow(turn.position)),
    history: {
      branchRevision: "branch",
      totalTurns: total,
      turns,
      hasOlder: start > 0,
      olderCursor: start > 0 ? `before:${start}` : undefined,
      hasNewer: end < total,
      newerCursor: end < total ? `after:${end}` : undefined,
    },
  };
}
export function childPreview(
  status: SubagentConversation["status"] = "completed",
  page = childPage(),
): SubagentConversation {
  const owner = { atSeq: page.atSeq, atRevision: page.atRevision, atLogEpoch: page.atLogEpoch };
  return { ...owner, rows: page.rows, history: page.history, totalCount: page.rows.length, status };
}
export function childDirectory(
  start = 0,
  count = 20,
  hasMore = false,
): V4ConversationHistoryDirectoryResult {
  return {
    ...watermark,
    totalTurns: 70,
    hasMore,
    nextCursor: hasMore ? `dir:${start + count}` : undefined,
    items: Array.from({ length: count }, (_, n) => ({
      entryId: `entry:${start + n}`,
      turnId: `turn:${start + n}`,
      position: start + n,
      preview: "question",
    })),
  };
}
export function childService(preview = childPreview()) {
  const listeners = new Set<(event: { workspaceKey: string }) => void>();
  const service = {
    getSubagentConversation: vi.fn(async () => preview),
    conversationHistoryPageV4: vi.fn(async () => childPage(30, 50)),
    conversationHistoryTurnV4: vi.fn(
      async (): Promise<V4ConversationHistoryTurnResult> => ({
        ...watermark,
        rows: [childRow(60)],
        turn: { turnId: "turn:60", userEntryId: "entry:60", position: 60, preview: "question" },
        hasMore: true,
        continuationCursor: "slice:2",
      }),
    ),
    conversationHistoryDirectoryV4: vi.fn(async () => childDirectory()),
    conversationHistoryContentV4: vi.fn(
      async (): Promise<V4ConversationHistoryContentResult> => ({
        ...watermark,
        ref: "ref",
        offset: 0,
        totalBytes: 10,
        encoding: "base64" as const,
        data: "YWJj",
        mediaType: "application/json",
        nextOffset: 3,
      }),
    ),
    onAgentRuntimeRestarted: vi.fn((listener: (event: { workspaceKey: string }) => void) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    }),
  };
  return {
    service,
    runtime: (workspaceKey = "ssh:trusted") => {
      for (const listener of listeners) listener({ workspaceKey });
    },
    listenerCount: () => listeners.size,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export const settleChild = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};
