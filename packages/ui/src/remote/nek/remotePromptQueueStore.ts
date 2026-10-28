import { create } from "zustand";
import type {
  RemoteHostKeyChangedEvent,
  RemotePromptEvent,
  RemotePromptRequest,
  RemotePromptResponse,
} from "@zcode/shared/nek-protocol";
import { logger } from "@/logger.js";

/** Sixteen prompts keeps accidental host floods bounded without hiding a normal burst. */
export const REMOTE_PROMPT_QUEUE_LIMIT = 16;

export type RemotePromptQueueItem = RemotePromptRequest | RemoteHostKeyChangedEvent;
export type RemotePromptCancellationReason =
  | "timeout"
  | "aborted"
  | "disconnected"
  | "superseded";
export type RemotePromptResponder = (
  id: string,
  response: RemotePromptResponse,
) => Promise<void> | void;

export interface RemotePromptNotice {
  id: "remote.nek.prompt.timeout" | "remote.nek.prompt.aborted" | "remote.nek.prompt.disconnected";
}

export interface RemotePromptQueueStateValue {
  items: readonly RemotePromptQueueItem[];
  notice: RemotePromptNotice | null;
}

export type RemotePromptQueueEvent =
  | { type: "enqueue"; item: RemotePromptQueueItem }
  | {
      type: "cancel";
      id: string;
      reason: "timeout" | "aborted" | "disconnected" | "superseded";
    }
  | { type: "remove"; id: string }
  | { type: "clearNotice" };

export const INITIAL_REMOTE_PROMPT_QUEUE_STATE: RemotePromptQueueStateValue = {
  items: [],
  notice: null,
};

function noticeForCancellation(reason: RemotePromptCancellationReason): RemotePromptNotice | null {
  switch (reason) {
    case "timeout":
      return { id: "remote.nek.prompt.timeout" };
    case "aborted":
      return { id: "remote.nek.prompt.aborted" };
    case "disconnected":
      return { id: "remote.nek.prompt.disconnected" };
    case "superseded":
      return null;
  }
}

/** Pure FIFO reducer. Invalid or stale events return the original state reference. */
export function reduceRemotePromptQueue(
  state: RemotePromptQueueStateValue,
  event: RemotePromptQueueEvent,
): RemotePromptQueueStateValue {
  switch (event.type) {
    case "enqueue": {
      if (state.items.some((item) => item.id === event.item.id)) return state;
      const items = [...state.items, event.item].slice(-REMOTE_PROMPT_QUEUE_LIMIT);
      return { ...state, items };
    }
    case "cancel": {
      const index = state.items.findIndex((item) => item.id === event.id);
      if (index < 0) return state;
      const items = state.items.filter((item) => item.id !== event.id);
      return {
        ...state,
        items,
        notice: index === 0 ? noticeForCancellation(event.reason) : state.notice,
      };
    }
    case "remove": {
      if (!state.items.some((item) => item.id === event.id)) return state;
      return { ...state, items: state.items.filter((item) => item.id !== event.id) };
    }
    case "clearNotice":
      return state.notice === null ? state : { ...state, notice: null };
  }
}

export interface RemotePromptQueueStore extends RemotePromptQueueStateValue {
  setResponder: (responder: RemotePromptResponder | null) => void;
  handleEvent: (event: RemotePromptEvent) => void;
  enqueuePrompt: (item: RemotePromptQueueItem) => void;
  cancelPrompt: (id: string, reason: RemotePromptCancellationReason) => void;
  removePrompt: (id: string) => void;
  clearNotice: () => void;
  respond: (id: string, response: RemotePromptResponse) => Promise<void>;
  reset: () => void;
}

export const useRemotePromptQueueStore = create<RemotePromptQueueStore>()((set, get) => {
  let responder: RemotePromptResponder | null = null;

  const apply = (event: RemotePromptQueueEvent): void => {
    set((state) => reduceRemotePromptQueue(state, event));
  };

  const cancelDroppedPrompt = (item: RemotePromptQueueItem | undefined): void => {
    if (!item || item.kind === "host_key_changed") return;
    if (!responder) {
      logger.error("[remotePromptQueue] no responder for overflowed remote prompt", item.id);
      return;
    }
    void Promise.resolve(responder(item.id, { cancelled: true })).catch((error: unknown) => {
      logger.error("[remotePromptQueue] failed to cancel overflowed remote prompt", error);
    });
  };

  return {
    ...INITIAL_REMOTE_PROMPT_QUEUE_STATE,
    setResponder(nextResponder) {
      responder = nextResponder;
    },
    handleEvent(event) {
      if ("kind" in event) {
        get().enqueuePrompt(event);
        return;
      }
      get().cancelPrompt(event.id, event.reason);
    },
    enqueuePrompt(item) {
      const current = get().items;
      const duplicate = current.some((candidate) => candidate.id === item.id);
      const dropped =
        !duplicate && current.length >= REMOTE_PROMPT_QUEUE_LIMIT ? current[0] : undefined;
      apply({ type: "enqueue", item });
      cancelDroppedPrompt(dropped);
    },
    cancelPrompt(id, reason) {
      apply({ type: "cancel", id, reason });
    },
    removePrompt(id) {
      apply({ type: "remove", id });
    },
    clearNotice() {
      apply({ type: "clearNotice" });
    },
    async respond(id, response) {
      const item = get().items.find((candidate) => candidate.id === id);
      if (!item || item.kind === "host_key_changed") return;
      if (!responder) throw new Error("Remote prompt responder is not configured");
      await responder(id, response);
      get().removePrompt(id);
    },
    reset() {
      responder = null;
      set(INITIAL_REMOTE_PROMPT_QUEUE_STATE);
    },
  };
});

export function selectActiveRemotePrompt(
  state: RemotePromptQueueStateValue,
): RemotePromptQueueItem | null {
  return state.items[0] ?? null;
}

export function selectRemotePromptQueueLength(state: RemotePromptQueueStateValue): number {
  return Math.max(0, state.items.length - 1);
}

export function subscribeRemotePromptQueue(
  onEvent: (listener: (event: RemotePromptEvent) => void) => () => void,
  responder: RemotePromptResponder,
): () => void {
  const store = useRemotePromptQueueStore.getState();
  store.setResponder(responder);
  const unsubscribe = onEvent((event) => store.handleEvent(event));
  return () => {
    unsubscribe();
    useRemotePromptQueueStore.getState().setResponder(null);
  };
}
