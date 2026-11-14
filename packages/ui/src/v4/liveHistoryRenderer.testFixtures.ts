import { vi } from "vitest";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
  V4ConversationHistoryPageResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjectionStore } from "./conversationProjectionStore.js";
import type { ConversationTransport } from "./transport.js";

export function liveRow(position: number, text = `answer ${position}`): ConversationRow {
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
export function livePage(
  start: number,
  end: number,
  total = end,
  branchRevision = `source:${total}`,
): V4ConversationHistoryPageResult {
  const turns = Array.from({ length: end - start }, (_, index) => ({
    turnId: `turn:${start + index}`,
    userEntryId: `entry:${start + index}`,
    position: start + index,
    preview: `question ${start + index}`,
  }));
  return {
    atSeq: 1,
    atRevision: 1,
    atLogEpoch: "epoch",
    rows: turns.map((turn) => liveRow(turn.position)),
    history: {
      branchRevision,
      totalTurns: total,
      turns,
      hasOlder: start > 0,
      olderCursor: start > 0 ? `before:${start}` : undefined,
      hasNewer: end < total,
      newerCursor: end < total ? `after:${end}` : undefined,
    },
  };
}
export function liveSnapshot(page = livePage(0, 20)): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "parent",
    logEpoch: "epoch",
    seq: 1,
    revision: 1,
    control: {
      phase: "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    meta: { title: "title", titleSource: "default" },
    config: {
      provider: "test",
      model: "test",
      thought: "off",
      thoughtLevels: ["off"],
      followupMode: "queue",
      mode: "agent",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    workspaceHookAdmission: null,
    rows: {
      window: page.rows,
      totalCount: page.rows.length,
      firstRowId: page.rows[0]?.rowId ?? null,
    },
    history: page.history,
  };
}
export function deferredValue<T>() {
  return Promise.withResolvers<T>();
}

export async function liveStore(initial = livePage(0, 20)) {
  const transport = {
    subscribe: vi.fn(async () => ({
      ack: { subscriptionId: "subscription", mode: "snapshot", logEpoch: "epoch" },
    })),
    activate: vi.fn(),
    unsubscribe: vi.fn(async () => {}),
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    historyPage: vi.fn(async (_options: unknown) => livePage(0, 20)),
    historyTurn: vi.fn(),
    historyDirectory: vi.fn(),
    historyContent: vi.fn(),
    rowsRange: vi.fn(),
    resync: vi.fn(async (_options: unknown) => ({
      ack: { subscriptionId: "subscription", mode: "snapshot", logEpoch: "epoch" },
    })),
    sendCommand: vi.fn(),
  };
  const store = new ConversationProjectionStore(
    "conversation/parent",
    transport as unknown as ConversationTransport,
  );
  await store.connect();
  const frame = (
    snapshot: ConversationSnapshot,
    deliveryKind: "initial" | "recovery" | "online" = "initial",
  ) =>
    store.handleFrame(
      {
        topic: "conversation/parent",
        subscriptionId: "subscription",
        sentAt: 1,
        fromSeq: 0,
        toSeq: snapshot.seq,
        payload: { kind: "snapshot", snapshot },
      },
      { deliveryKind },
    );
  frame(liveSnapshot(initial));
  const deltaFrame = (
    deltas: ConversationDelta[],
    fromSeq = store.getState().snapshot!.seq,
  ): ConversationTopicFrame => ({
    topic: "conversation/parent",
    subscriptionId: "subscription",
    sentAt: 1,
    fromSeq,
    toSeq: fromSeq + 1,
    payload: {
      kind: "deltas",
      deltas: [...deltas, { op: "state.updated", patch: { revision: fromSeq + 1 } }],
    },
  });
  const send = (deltas: ConversationDelta[]) =>
    store.handleFrame(JSON.parse(JSON.stringify(deltaFrame(deltas))));
  const append = (position: number) =>
    send([
      { op: "row.appended", row: liveRow(position) },
      {
        op: "state.updated",
        patch: {
          history: {
            ...livePage(Math.max(0, position - 19), position + 1).history,
            turns: livePage(Math.max(0, position - 19), position + 1).history.turns.map((turn) => ({
              ...turn,
              continuationCursor: `FULL:${turn.turnId}`,
            })),
          },
        },
      },
    ]);
  const atCurrent = (result: V4ConversationHistoryPageResult) => ({
    ...result,
    atSeq: store.getState().snapshot!.seq,
    atRevision: store.getState().snapshot!.revision,
  });
  return { store, transport, frame, send, append, deltaFrame, atCurrent };
}
