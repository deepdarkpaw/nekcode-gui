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
  type InteractionQueueState,
  type InteractionRequestRecord,
  type PendingInteractionRequest,
} from "./interactionQueue.js";

/** Session slots are bounded so disconnected sessions cannot retain renderer memory forever. */
export const INTERACTION_SESSION_LIMIT = 32;
/** Fire-and-forget notifications are an event stream, not an unbounded toast history. */
export const INTERACTION_EFFECT_LIMIT = 64;
export const INTERACTION_STATUS_LIMIT = 32;
export const INTERACTION_WIDGET_LIMIT = 16;
export const INTERACTION_WIDGET_LINE_LIMIT = 50;
export const INTERACTION_TICK_MS = 1000;

export interface InteractionWidget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
  truncated: boolean;
}

export interface InteractionSessionState extends InteractionQueueState {
  effects: NekExtensionUiEffect[];
  statuses: Readonly<Record<string, string>>;
  widgets: Readonly<Record<string, InteractionWidget>>;
  titleOverride?: string;
  clockMs: number;
}

export type InteractionResponder = (sessionKey: string, response: NekExtensionUiResponse) => void;
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
  cancelByUser: (sessionKey: string, requestId: string) => boolean;
  cancelByHost: (sessionKey: string, requestId: string) => boolean;
  cancelById: (requestId: string) => boolean;
  disconnect: (sessionKey: string) => void;
  handleFireAndForget: (sessionKey: string, request: NekExtensionUiFireAndForgetRequest) => boolean;
  tick: (now?: number) => void;
  getHead: (sessionKey: string) => InteractionRequestRecord | undefined;
  getRemainingMs: (sessionKey: string, requestId?: string, now?: number) => number | undefined;
  takeEffects: (sessionKey: string) => NekExtensionUiEffect[];
  takeNotices: (sessionKey: string) => InteractionSessionState["notices"];
  shutdown: () => void;
}

function timeoutMs(request: PendingInteractionRequest): number | undefined {
  if (!("timeout" in request) || typeof request.timeout !== "number") return undefined;
  if (!Number.isFinite(request.timeout)) return undefined;
  return Math.max(0, request.timeout);
}

function createSession(now: number): InteractionSessionState {
  return {
    ...EMPTY_INTERACTION_QUEUE,
    effects: [],
    statuses: {},
    widgets: {},
    clockMs: now,
  };
}

function hasDeadline(sessions: Readonly<Record<string, InteractionSessionState>>): boolean {
  return Object.values(sessions).some((session) =>
    session.queue.some((record) => record.deadline !== undefined),
  );
}

function sessionWithQueue(
  session: InteractionSessionState,
  queue: InteractionQueueState,
): InteractionSessionState {
  return { ...session, ...queue };
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
      for (const item of outbox) options.respond(sessionKey, item.response);
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
      const existing = get().sessions[sessionKey];
      if (!existing) return;
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[sessionKey];
        return { sessions };
      });
      refreshTicker();
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
        options.respond(sessionKey, response);
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
        for (const [sessionKey, session] of Object.entries(get().sessions)) {
          if (session.queue.some((record) => record.request.id === requestId)) {
            return get().cancelByHost(sessionKey, requestId);
          }
        }
        return false;
      },
      disconnect: disconnectSession,
      handleFireAndForget: (sessionKey, request) => {
        const session = ensureSession(sessionKey);
        if (!session) return false;
        const effect = toNekExtensionUiEffect(request);
        set((state) => {
          const current = state.sessions[sessionKey];
          if (!current) return state;
          let statuses = { ...current.statuses };
          let widgets = { ...current.widgets };
          let titleOverride = current.titleOverride;
          let effects = [...current.effects, effect].slice(-INTERACTION_EFFECT_LIMIT);
          if (effect.kind === "toast") {
            // Toast remains an event so the host can map it to a notification without UI coupling.
          } else if (effect.kind === "setStatus") {
            if (!effect.statusText?.trim()) {
              delete statuses[effect.statusKey];
            } else {
              if (
                !Object.hasOwn(statuses, effect.statusKey) &&
                Object.keys(statuses).length >= INTERACTION_STATUS_LIMIT
              ) {
                const oldest = Object.keys(statuses)[0];
                if (oldest) delete statuses[oldest];
                logger.warn("[NekInteractionStore] status limit reached");
              }
              statuses[effect.statusKey] = effect.statusText;
            }
          } else if (effect.kind === "setWidget") {
            if (!effect.widgetLines) {
              delete widgets[effect.widgetKey];
            } else {
              const truncated = effect.widgetLines.length > INTERACTION_WIDGET_LINE_LIMIT;
              const nextWidget = {
                lines: effect.widgetLines.slice(0, INTERACTION_WIDGET_LINE_LIMIT),
                placement: effect.widgetPlacement,
                truncated,
              } satisfies InteractionWidget;
              if (
                !Object.hasOwn(widgets, effect.widgetKey) &&
                Object.keys(widgets).length >= INTERACTION_WIDGET_LIMIT
              ) {
                const oldest = Object.keys(widgets)[0];
                if (oldest) delete widgets[oldest];
                logger.warn("[NekInteractionStore] widget limit reached");
              }
              widgets[effect.widgetKey] = nextWidget;
            }
          } else if (effect.kind === "setTitle") {
            titleOverride = effect.title || undefined;
          }
          return {
            sessions: {
              ...state.sessions,
              [sessionKey]: { ...current, effects, statuses, widgets, titleOverride },
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
      },
    } satisfies NekInteractionStore;
  });

  return store;
}

/** Renderer-wide queue hook; transport wiring supplies requests and response callbacks. */
export const useNekInteractionStore = createNekInteractionStore({
  respond: () => undefined,
  onEffect: () => undefined,
});
