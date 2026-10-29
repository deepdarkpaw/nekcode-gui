import type {
  NekExtensionUiDialogRequest,
  NekExtensionUiResponse,
  NekStructuredUiRequest,
} from "@zcode/shared/nek-protocol";

/** Per-session FIFO capacity. Older requests are cancelled rather than silently overwritten. */
export const INTERACTION_QUEUE_LIMIT = 32;
/** Retained request ids make late responses observable as no-ops without unbounded history. */
export const CLOSED_REQUEST_LIMIT = 64;

export type PendingInteractionRequest = NekExtensionUiDialogRequest | NekStructuredUiRequest;

export interface InteractionRequestRecord {
  request: PendingInteractionRequest;
  receivedAt: number;
  deadline?: number;
}

export interface QueueOutboxItem {
  requestId: string;
  response: NekExtensionUiResponse;
}

export interface InteractionNotice {
  requestId: string;
  id: "nek.interaction.cancelledByHost" | "nek.interaction.timedOut";
}

export interface InteractionQueueState {
  queue: InteractionRequestRecord[];
  drafts: Readonly<Record<string, unknown>>;
  closedRequestIds: string[];
  outbox: QueueOutboxItem[];
  notices: InteractionNotice[];
}

export const EMPTY_INTERACTION_QUEUE: InteractionQueueState = {
  queue: [],
  drafts: {},
  closedRequestIds: [],
  outbox: [],
  notices: [],
};

export type InteractionQueueEvent =
  | { type: "enqueue"; record: InteractionRequestRecord }
  | { type: "setDraft"; requestId: string; draft: unknown }
  | { type: "remove"; requestId: string; reason: "user" | "host" | "settled" }
  | { type: "tick"; now: number }
  | { type: "drainOutbox" }
  | { type: "drainNotices" }
  | { type: "disconnect" };

function rememberClosed(ids: readonly string[], requestId: string): string[] {
  const next = ids.filter((id) => id !== requestId);
  next.push(requestId);
  return next.slice(-CLOSED_REQUEST_LIMIT);
}

function removeRecord(
  state: InteractionQueueState,
  requestId: string,
  reason: "user" | "host" | "settled",
): InteractionQueueState {
  const record = state.queue.find((candidate) => candidate.request.id === requestId);
  if (!record) return state;
  const queue = state.queue.filter((candidate) => candidate.request.id !== requestId);
  const drafts = { ...state.drafts };
  const hadDraft = Object.hasOwn(drafts, requestId);
  delete drafts[requestId];
  return {
    ...state,
    queue,
    drafts,
    closedRequestIds: rememberClosed(state.closedRequestIds, requestId),
    notices:
      reason === "host" && hadDraft
        ? [...state.notices, { requestId, id: "nek.interaction.cancelledByHost" }]
        : state.notices,
  };
}

function cancelRecord(
  state: InteractionQueueState,
  record: InteractionRequestRecord,
  noticeId: InteractionNotice["id"] | undefined,
): InteractionQueueState {
  const next = removeRecord(state, record.request.id, "settled");
  return {
    ...next,
    outbox: [
      ...next.outbox,
      {
        requestId: record.request.id,
        response: { type: "extension_ui_response", id: record.request.id, cancelled: true },
      },
    ],
    notices: noticeId
      ? [...next.notices, { requestId: record.request.id, id: noticeId }]
      : next.notices,
  };
}

/** Pure FIFO state machine. Invalid events return the exact state reference. */
export function reduceInteractionQueue(
  state: InteractionQueueState,
  event: InteractionQueueEvent,
): InteractionQueueState {
  switch (event.type) {
    case "enqueue": {
      if (state.queue.some((record) => record.request.id === event.record.request.id)) return state;
      const queue = [...state.queue, event.record];
      let next: InteractionQueueState = { ...state, queue };
      if (queue.length <= INTERACTION_QUEUE_LIMIT) return next;
      const dropped = queue[0];
      if (!dropped) return next;
      next = cancelRecord(next, dropped, undefined);
      return next;
    }
    case "setDraft": {
      if (!state.queue.some((record) => record.request.id === event.requestId)) return state;
      return { ...state, drafts: { ...state.drafts, [event.requestId]: event.draft } };
    }
    case "remove":
      return removeRecord(state, event.requestId, event.reason);
    case "tick": {
      let next = state;
      for (const record of state.queue) {
        if (record.deadline !== undefined && event.now >= record.deadline) {
          next = cancelRecord(next, record, "nek.interaction.timedOut");
        }
      }
      return next;
    }
    case "drainOutbox":
      return state.outbox.length === 0 ? state : { ...state, outbox: [] };
    case "drainNotices":
      return state.notices.length === 0 ? state : { ...state, notices: [] };
    case "disconnect":
      return state.queue.length === 0 && Object.keys(state.drafts).length === 0
        ? state
        : { ...EMPTY_INTERACTION_QUEUE, closedRequestIds: state.closedRequestIds };
  }
}

export function getQueueHead(state: InteractionQueueState): InteractionRequestRecord | undefined {
  return state.queue[0];
}

export function getRemainingInteractionMs(
  record: InteractionRequestRecord | undefined,
  now: number,
): number | undefined {
  if (record?.deadline === undefined) return undefined;
  return Math.max(0, record.deadline - now);
}
