import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type { IZCodeAgentService } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import type { NekAgentTypeInfo, NekInteractionFrame } from "@zcode/shared/nek-protocol";
import { logger } from "@/logger.js";
import {
  useNekInteractionStore,
  type InteractionResponder,
  type NekInteractionStoreApi,
} from "@/nek/interactions/interactionStore.js";
import type { WorkspaceConnectionAgentService } from "@/v4/workspaceConnectionRegistry.js";

type NekAgentFeedTargetBase = Parameters<IZCodeAgentService["onDynamicNekInteractionFrame"]>[0];
type NekRespondParams = Parameters<IZCodeAgentService["respondNekInteraction"]>[0];
type NekStopParams = Parameters<IZCodeAgentService["stopSubagent"]>[0];
type NekTranscriptParams = Parameters<IZCodeAgentService["getSubagentTranscript"]>[0];
type NekAgentTypesParams = Parameters<IZCodeAgentService["listAgentTypes"]>[0];

/** The feed only exposes the renderer-facing interaction and subagent RPC surface. */
export type NekAgentFeedService = Pick<
  IZCodeAgentService,
  | "onDynamicNekInteractionFrame"
  | "respondNekInteraction"
  | "stopSubagent"
  | "getSubagentTranscript"
  | "listAgentTypes"
>;

export interface NekAgentFeedTarget extends NekAgentFeedTargetBase {
  /** The remote endpoint identity is used by the surrounding service resolver. */
  remoteSessionId?: string;
}

export interface NekAgentFeed {
  respond(params: NekRespondParams): Promise<void>;
  stopSubagent(params: NekStopParams): ReturnType<IZCodeAgentService["stopSubagent"]>;
  getSubagentTranscript(
    params: NekTranscriptParams,
  ): ReturnType<IZCodeAgentService["getSubagentTranscript"]>;
  listAgentTypes(params: NekAgentTypesParams): ReturnType<IZCodeAgentService["listAgentTypes"]>;
}

/** Adapter shape matches the existing three controller injection points. */
export interface NekSubagentControllerFeed {
  onStop: (id: string) => Promise<void>;
  fetchTranscript: (id: string) => Promise<{ messages: unknown[] }>;
  listAgentTypes: () => Promise<{ types: NekAgentTypeInfo[] }>;
}

export function createNekSubagentControllerFeed(
  feed: NekAgentFeed,
  target: NekAgentFeedTarget,
  sessionId: string,
): NekSubagentControllerFeed {
  const sessionTarget = { ...target, sessionId } as NekStopParams;
  return {
    onStop: async (id) => {
      await feed.stopSubagent({ ...sessionTarget, id });
    },
    fetchTranscript: async (id) => await feed.getSubagentTranscript({ ...sessionTarget, id }),
    listAgentTypes: async () => await feed.listAgentTypes(sessionTarget),
  };
}

interface FeedEntry {
  feed: NekAgentFeed;
  refs: number;
  dispose: () => void;
}

const feedEntries = new WeakMap<object, Map<string, FeedEntry>>();

function targetKey(target: NekAgentFeedTarget): string {
  return JSON.stringify([
    target.workspacePath,
    target.workspaceIdentity ?? "",
    target.remoteSessionId ?? "",
  ]);
}

function frameSessionKey(frame: NekInteractionFrame, target: NekAgentFeedTarget): string {
  return frame.scope.sessionId ?? frame.scope.sessionKey ?? target.workspacePath;
}

/**
 * 一条 feed 记住的会话键上限：一个 workspace 上打开过的会话数量有限，超出只丢最旧的键
 * （队列本身由 store 的 32 会话 LRU 收口），避免长时间打开的窗格无限增长。
 */
const NEK_FEED_SESSION_KEY_LIMIT = 64;

/** 记住会话键，返回被挤出上限的那个键（没有就是 undefined）。 */
function rememberSessionKey(sessionKeys: Set<string>, sessionKey: string): string | undefined {
  if (sessionKeys.has(sessionKey)) return undefined;
  sessionKeys.add(sessionKey);
  if (sessionKeys.size <= NEK_FEED_SESSION_KEY_LIMIT) return undefined;
  const oldest = sessionKeys.values().next();
  if (oldest.done) return undefined;
  sessionKeys.delete(oldest.value);
  logger.warn("[nekAgentFeed] dropping the oldest tracked session key", {
    sessionKey: oldest.value,
  });
  return oldest.value;
}

function createNekAgentFeed(
  service: NekAgentFeedService,
  target: NekAgentFeedTarget,
  store: NekInteractionStoreApi,
): FeedEntry {
  const sessionKeys = new Set<string>([target.workspacePath]);
  let subscription: IDisposable | undefined;
  let feed: NekAgentFeed;
  // 这个 workspace 的所有会话都用 feed 回答：组件触发的回答走 settleAsync，
  // 超时/丢弃这类非组件触发的取消回答由 store 通过这里注册的通道送回后端。
  const storeResponder: InteractionResponder = async (_sessionKey, response) =>
    await feed.respond({ requestId: response.id, response });
  const ingest = (frame: NekInteractionFrame): void => {
    const sessionKey = frameSessionKey(frame, target);
    const evicted = rememberSessionKey(sessionKeys, sessionKey);
    if (evicted !== undefined) store.getState().clearResponder(evicted, storeResponder);
    store.getState().setResponder(sessionKey, storeResponder);
    if (frame.kind === "request") {
      store.getState().enqueueExtensionRequest(sessionKey, frame.request);
      return;
    }
    // 请求 id 全局唯一；按 id 找会话可以覆盖"发出请求的会话随后被回收"的撤销帧。
    store.getState().cancelById(frame.id);
  };
  feed = {
    respond: async ({ requestId, response }) => {
      try {
        await service.respondNekInteraction({ requestId, response });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no longer pending|unknown interaction/u.test(message)) {
          // 后端已经不认识这条请求：先撤掉过期卡片并留下一次性提示，再把错误交给控制器。
          store.getState().cancelStaleById(requestId);
          throw new Error(`Interaction ${requestId} is no longer pending: ${message}`);
        }
        // 传输失败必须让请求留在队列里：控制器显示错误，用户可以原样重试。
        throw error;
      }
    },
    stopSubagent: async (params) => await service.stopSubagent(params),
    getSubagentTranscript: async (params) => await service.getSubagentTranscript(params),
    listAgentTypes: async (params) => await service.listAgentTypes(params),
  };
  const start = (): void => {
    if (subscription) return;
    subscription = service.onDynamicNekInteractionFrame(target)(ingest);
  };
  const dispose = (): void => {
    subscription?.dispose();
    subscription = undefined;
    for (const sessionKey of sessionKeys) {
      store.getState().clearResponder(sessionKey, storeResponder);
      store.getState().disconnect(sessionKey);
    }
    sessionKeys.clear();
  };
  store.getState().setResponder(target.workspacePath, storeResponder);
  start();
  return { feed, refs: 1, dispose };
}

/** Start one workspace feed and share it between split panes on the same service endpoint. */
export function acquireNekAgentFeed(
  service: NekAgentFeedService,
  target: NekAgentFeedTarget,
  store: NekInteractionStoreApi = useNekInteractionStore,
): { feed: NekAgentFeed; release: () => void } {
  const serviceEntries = feedEntries.get(service);
  const key = targetKey(target);
  const existing = serviceEntries?.get(key);
  const entry = existing ?? createNekAgentFeed(service, target, store);
  if (existing) {
    existing.refs += 1;
  } else {
    const nextEntries = serviceEntries ?? new Map<string, FeedEntry>();
    nextEntries.set(key, entry);
    feedEntries.set(service, nextEntries);
  }
  let released = false;
  return {
    feed: entry.feed,
    release: () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      entry.dispose();
      const entries = feedEntries.get(service);
      entries?.delete(key);
      if (entries?.size === 0) feedEntries.delete(service);
    },
  };
}

const NekAgentFeedContext = createContext<{
  feed: NekAgentFeed;
  target: NekAgentFeedTarget;
} | null>(null);

interface NekAgentFeedProviderProps {
  service: NekAgentFeedService;
  target: NekAgentFeedTarget;
  children: ReactNode;
}

export function NekAgentFeedProvider({ service, target, children }: NekAgentFeedProviderProps) {
  const lease = useMemo(() => acquireNekAgentFeed(service, target), [service, target]);
  useEffect(() => () => lease.release(), [lease]);
  const value = useMemo(() => ({ feed: lease.feed, target }), [lease, target]);
  return createElement(NekAgentFeedContext.Provider, { value }, children);
}

function useOptionalNekAgentFeed(): NekAgentFeed | null {
  return useContext(NekAgentFeedContext)?.feed ?? null;
}

export function useNekAgentFeed(): NekAgentFeed {
  const feed = useOptionalNekAgentFeed();
  if (!feed) throw new Error("useNekAgentFeed must be used inside NekAgentFeedProvider");
  return feed;
}

/** feed 绑定的 workspace 目标：子代理 RPC 在同一目标上补 sessionId。 */
export function useNekAgentFeedTarget(): NekAgentFeedTarget {
  const value = useContext(NekAgentFeedContext);
  if (!value) throw new Error("useNekAgentFeedTarget must be used inside NekAgentFeedProvider");
  return value.target;
}

export const NEK_AGENT_FEED_METHODS = [
  "onDynamicNekInteractionFrame",
  "respondNekInteraction",
  "stopSubagent",
  "getSubagentTranscript",
  "listAgentTypes",
] as const satisfies readonly (keyof WorkspaceConnectionAgentService)[];
