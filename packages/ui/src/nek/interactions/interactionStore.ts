import { create } from "zustand";
import type {
  NekExtensionUiFireAndForgetRequest,
  NekExtensionUiRequest,
  NekExtensionUiResponse,
} from "@zcode/shared/nek-protocol";
import { logger } from "@/logger.js";
import {
  classifyNekExtensionUiRequest,
  isNekExtensionUiDialogRequest,
  isNekExtensionUiFireAndForgetRequest,
  isNekStructuredUiRequest,
  toNekExtensionUiEffect,
  type NekExtensionUiEffect,
} from "./extensionUi.js";
import {
  EMPTY_INTERACTION_QUEUE,
  getQueueHead,
  getRemainingInteractionMs,
  reduceInteractionQueue,
  type InteractionNotice,
  type InteractionRequestRecord,
  type PendingInteractionRequest,
} from "./interactionQueue.js";
import {
  applyFireAndForgetEffect,
  createSession,
  hasDeadline,
  sessionWithQueue,
  timeoutMs,
  type InteractionSessionState,
} from "./interactionSessionState.js";

/** Session slots are bounded so disconnected sessions cannot retain renderer memory forever. */
export const INTERACTION_SESSION_LIMIT = 32;
export const INTERACTION_TICK_MS = 1000;
/** 一次性提示只用于"卡片刚被撤销"的说明，超出即丢最旧的，避免无限堆积。 */
const INTERACTION_NOTICE_LIMIT = 8;

export type { InteractionSessionState } from "./interactionSessionState.js";

export type InteractionResponder = (
  sessionKey: string,
  response: NekExtensionUiResponse,
) => unknown | Promise<unknown>;
export type InteractionEffectHandler = (sessionKey: string, effect: NekExtensionUiEffect) => void;

export interface NekInteractionStoreOptions {
  respond: InteractionResponder;
  onEffect: InteractionEffectHandler;
  now?: () => number;
  setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface NekInteractionStore {
  sessions: Readonly<Record<string, InteractionSessionState>>;
  enqueue: (sessionKey: string, request: PendingInteractionRequest) => boolean;
  enqueueExtensionRequest: (sessionKey: string, request: NekExtensionUiRequest) => boolean;
  updateDraft: (sessionKey: string, requestId: string, draft: unknown) => boolean;
  settle: (sessionKey: string, requestId: string, response: NekExtensionUiResponse) => boolean;
  settleAsync: (
    sessionKey: string,
    requestId: string,
    response: NekExtensionUiResponse,
    responder?: InteractionResponder,
  ) => Promise<boolean>;
  cancelByUser: (sessionKey: string, requestId: string) => boolean;
  cancelByHost: (sessionKey: string, requestId: string) => boolean;
  cancelById: (requestId: string) => boolean;
  /**
   * 后端已经不认识这条请求（已取消或已结算）：移除卡片，并留下一次性提示，
   * 同时把 id 记进 closedRequestIds 让迟到的回调失效。
   */
  cancelStaleById: (requestId: string) => boolean;
  /**
   * 绑定某个会话键的回答通道：feed 在订阅期间注册，超时/丢弃这类**非组件触发**的取消
   * 回答也就能真的回到后端，而不是落到创建 store 时的兜底实现上。
   */
  setResponder: (sessionKey: string, responder: InteractionResponder) => void;
  /** 只在当前注册的仍是同一个实现时移除，避免换连接时把新 feed 的注册一起清掉。 */
  clearResponder: (sessionKey: string, responder: InteractionResponder) => void;
  disconnect: (sessionKey: string) => void;
  handleFireAndForget: (sessionKey: string, request: NekExtensionUiFireAndForgetRequest) => boolean;
  tick: (now?: number) => void;
  getHead: (sessionKey: string) => InteractionRequestRecord | undefined;
  getRemainingMs: (sessionKey: string, requestId?: string, now?: number) => number | undefined;
  takeEffects: (sessionKey: string) => NekExtensionUiEffect[];
  takeNotices: (sessionKey: string) => InteractionSessionState["notices"];
  shutdown: () => void;
}

export type NekInteractionStoreApi = ReturnType<typeof createNekInteractionStore>;

export function createNekInteractionStore(options: NekInteractionStoreOptions) {
  const now = options.now ?? (() => Date.now());
  const setIntervalFn =
    options.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let intervalHandle: unknown = null;
  const settlingIds = new Set<string>();
  const sessionResponders = new Map<string, InteractionResponder>();
  const responderFor = (sessionKey: string): InteractionResponder =>
    sessionResponders.get(sessionKey) ?? options.respond;
  /** 送达一条回答；失败只记录，不让它变成未处理的 rejection。 */
  const deliver = (sessionKey: string, response: NekExtensionUiResponse): void => {
    void Promise.resolve(responderFor(sessionKey)(sessionKey, response)).catch((error: unknown) => {
      logger.warn("[NekInteractionStore] response delivery failed", error);
    });
  };

  const store = create<NekInteractionStore>((set, get) => {
    const flushQueueEffects = (sessionKey: string): void => {
      const session = get().sessions[sessionKey];
      if (!session) return;
      const outbox = session.outbox;
      if (outbox.length === 0) return;
      set((state) => {
        const current = state.sessions[sessionKey];
        if (!current) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionKey]: sessionWithQueue(
              current,
              reduceInteractionQueue(current, { type: "drainOutbox" }),
            ),
          },
        };
      });
      // 超时/被丢弃请求的取消回答同样要真的回到后端（走该会话注册的回答通道）。
      for (const item of outbox) deliver(sessionKey, item.response);
    };

    const ensureSession = (sessionKey: string): InteractionSessionState | undefined => {
      const existing = get().sessions[sessionKey];
      if (existing) return existing;
      const entries = Object.entries(get().sessions);
      if (entries.length >= INTERACTION_SESSION_LIMIT) {
        const oldest = entries[0];
        if (!oldest) return undefined;
        logger.warn("[NekInteractionStore] evicting oldest session", oldest[0]);
        disconnectSession(oldest[0]);
      }
      const session = createSession(now());
      set((state) => ({ sessions: { ...state.sessions, [sessionKey]: session } }));
      return session;
    };

    const applyQueueEvent = (
      sessionKey: string,
      event: Parameters<typeof reduceInteractionQueue>[1],
    ): void => {
      const session = ensureSession(sessionKey);
      if (!session) return;
      set((state) => {
        const current = state.sessions[sessionKey];
        if (!current) return state;
        const queue = reduceInteractionQueue(current, event);
        if (queue === current) return state;
        return { sessions: { ...state.sessions, [sessionKey]: sessionWithQueue(current, queue) } };
      });
      flushQueueEffects(sessionKey);
    };

    const refreshTicker = (): void => {
      const shouldRun = hasDeadline(get().sessions);
      if (shouldRun && intervalHandle === null) {
        intervalHandle = setIntervalFn(() => get().tick(), INTERACTION_TICK_MS);
      } else if (!shouldRun && intervalHandle !== null) {
        clearIntervalFn(intervalHandle);
        intervalHandle = null;
      }
    };

    function disconnectSession(sessionKey: string): void {
      // 回答通道的注册归 feed 所有：换连接时新 feed 可能已经注册同一个键，
      // 这里删掉会把新连接的回答一起丢掉，只在 feed 释放时按身份清除。
      const existing = get().sessions[sessionKey];
      if (!existing) return;
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[sessionKey];
        return { sessions };
      });
      refreshTicker();
    }

    /** 追加一次性提示；同一条请求的同一种提示不重复堆积，整体保持在有界上限内。 */
    function pushNotice(sessionKey: string, notice: InteractionNotice): void {
      set((state) => {
        const current = state.sessions[sessionKey];
        if (!current) return state;
        if (
          current.notices.some(
            (candidate) => candidate.requestId === notice.requestId && candidate.id === notice.id,
          )
        ) {
          return state;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionKey]: {
              ...current,
              notices: [...current.notices, notice].slice(-INTERACTION_NOTICE_LIMIT),
            },
          },
        };
      });
    }

    function findSessionKeyByRequestId(requestId: string): string | undefined {
      for (const [sessionKey, session] of Object.entries(get().sessions)) {
        if (session.queue.some((record) => record.request.id === requestId)) return sessionKey;
      }
      return undefined;
    }

    return {
      sessions: {},
      enqueue: (sessionKey, request) => {
        const session = ensureSession(sessionKey);
        if (!session) return false;
        const timeout = timeoutMs(request);
        const receivedAt = now();
        const record: InteractionRequestRecord = {
          request,
          receivedAt,
          ...(timeout === undefined ? {} : { deadline: receivedAt + timeout }),
        };
        const duplicate = Boolean(
          get().sessions[sessionKey]?.queue.some(
            (candidate) => candidate.request.id === request.id,
          ),
        );
        applyQueueEvent(sessionKey, { type: "enqueue", record });
        const current = get().sessions[sessionKey];
        const accepted =
          !duplicate &&
          Boolean(
            current?.queue.some((candidate) => candidate.request.id === request.id) ||
            current?.outbox.some((item) => item.requestId === request.id),
          );
        get().tick(receivedAt);
        refreshTicker();
        return accepted;
      },
      enqueueExtensionRequest: (sessionKey, request) => {
        const kind = classifyNekExtensionUiRequest(request);
        if (kind === "fire-and-forget" && isNekExtensionUiFireAndForgetRequest(request)) {
          return get().handleFireAndForget(sessionKey, request);
        }
        if (isNekExtensionUiDialogRequest(request) || isNekStructuredUiRequest(request)) {
          return get().enqueue(sessionKey, request);
        }
        return false;
      },
      updateDraft: (sessionKey, requestId, draft) => {
        const before = get().sessions[sessionKey]?.drafts[requestId];
        applyQueueEvent(sessionKey, { type: "setDraft", requestId, draft });
        return before !== get().sessions[sessionKey]?.drafts[requestId];
      },
      settle: (sessionKey, requestId, response) => {
        const session = get().sessions[sessionKey];
        if (!session?.queue.some((record) => record.request.id === requestId)) return false;
        applyQueueEvent(sessionKey, { type: "remove", requestId, reason: "settled" });
        deliver(sessionKey, response);
        refreshTicker();
        return true;
      },
      settleAsync: async (sessionKey, requestId, response, responder) => {
        const session = get().sessions[sessionKey];
        if (
          !session?.queue.some((record) => record.request.id === requestId) ||
          settlingIds.has(requestId)
        ) {
          return false;
        }
        settlingIds.add(requestId);
        try {
          // 回答真正送达后端之后才关闭卡片：失败时请求留在队列里（草稿也保留），
          // 控制器把错误挂在动作上，用户可以原样重试。
          await (responder ?? responderFor(sessionKey))(sessionKey, response);
        } finally {
          settlingIds.delete(requestId);
        }
        if (get().sessions[sessionKey]?.queue.some((record) => record.request.id === requestId)) {
          applyQueueEvent(sessionKey, { type: "remove", requestId, reason: "settled" });
        }
        // 送达成功即结算；后端在途中撤销时（cancel 帧先到）队列已经清空，不算失败。
        refreshTicker();
        return true;
      },
      cancelByUser: (sessionKey, requestId) =>
        get().settle(sessionKey, requestId, {
          type: "extension_ui_response",
          id: requestId,
          cancelled: true,
        }),
      cancelByHost: (sessionKey, requestId) => {
        const session = get().sessions[sessionKey];
        if (!session?.queue.some((record) => record.request.id === requestId)) return false;
        applyQueueEvent(sessionKey, { type: "remove", requestId, reason: "host" });
        refreshTicker();
        return true;
      },
      cancelById: (requestId) => {
        const sessionKey = findSessionKeyByRequestId(requestId);
        return sessionKey ? get().cancelByHost(sessionKey, requestId) : false;
      },
      setResponder: (sessionKey, responder) => {
        sessionResponders.set(sessionKey, responder);
      },
      clearResponder: (sessionKey, responder) => {
        if (sessionResponders.get(sessionKey) === responder) sessionResponders.delete(sessionKey);
      },
      cancelStaleById: (requestId) => {
        const sessionKey = findSessionKeyByRequestId(requestId);
        if (!sessionKey) return false;
        applyQueueEvent(sessionKey, { type: "remove", requestId, reason: "host" });
        pushNotice(sessionKey, { requestId, id: "nek.interaction.cancelledByHost" });
        refreshTicker();
        return true;
      },
      disconnect: disconnectSession,
      handleFireAndForget: (sessionKey, request) => {
        const session = ensureSession(sessionKey);
        if (!session) return false;
        const effect = toNekExtensionUiEffect(request);
        set((state) => {
          const current = state.sessions[sessionKey];
          if (!current) return state;
          return {
            sessions: {
              ...state.sessions,
              [sessionKey]: { ...current, ...applyFireAndForgetEffect(current, effect) },
            },
          };
        });
        options.onEffect(sessionKey, effect);
        return true;
      },
      tick: (at = now()) => {
        for (const sessionKey of Object.keys(get().sessions)) {
          set((state) => {
            const current = state.sessions[sessionKey];
            if (!current) return state;
            const queue = reduceInteractionQueue(current, { type: "tick", now: at });
            const next = { ...sessionWithQueue(current, queue), clockMs: at };
            return { sessions: { ...state.sessions, [sessionKey]: next } };
          });
          flushQueueEffects(sessionKey);
        }
        refreshTicker();
      },
      getHead: (sessionKey) => getQueueHead(get().sessions[sessionKey] ?? EMPTY_INTERACTION_QUEUE),
      getRemainingMs: (sessionKey, requestId, at = now()) => {
        const record = requestId
          ? get().sessions[sessionKey]?.queue.find(
              (candidate) => candidate.request.id === requestId,
            )
          : getQueueHead(get().sessions[sessionKey] ?? EMPTY_INTERACTION_QUEUE);
        return getRemainingInteractionMs(record, at);
      },
      takeEffects: (sessionKey) => {
        const effects = get().sessions[sessionKey]?.effects ?? [];
        set((state) => {
          const current = state.sessions[sessionKey];
          if (!current || effects.length === 0) return state;
          return { sessions: { ...state.sessions, [sessionKey]: { ...current, effects: [] } } };
        });
        return effects;
      },
      takeNotices: (sessionKey) => {
        const notices = get().sessions[sessionKey]?.notices ?? [];
        set((state) => {
          const current = state.sessions[sessionKey];
          if (!current || notices.length === 0) return state;
          const queue = reduceInteractionQueue(current, { type: "drainNotices" });
          return {
            sessions: { ...state.sessions, [sessionKey]: sessionWithQueue(current, queue) },
          };
        });
        return notices;
      },
      shutdown: () => {
        if (intervalHandle !== null) clearIntervalFn(intervalHandle);
        intervalHandle = null;
        settlingIds.clear();
        sessionResponders.clear();
      },
    } satisfies NekInteractionStore;
  });

  return store;
}

/** Renderer-wide queue hook; transport wiring supplies requests and response callbacks. */
export const useNekInteractionStore = createNekInteractionStore({
  respond: () => undefined,
  onEffect: (sessionKey, effect) => {
    // NekInteractionHost drains the bounded effect outbox into the existing toast/composer UI.
    logger.debug("[NekInteractionStore] fire-and-forget effect queued", {
      sessionKey,
      kind: effect.kind,
      id: effect.id,
    });
  },
});
