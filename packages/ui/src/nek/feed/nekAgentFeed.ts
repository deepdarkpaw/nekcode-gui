import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { IZCodeAgentService } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import type {
  NekAgentTypeInfo,
  NekExtensionUiResponse,
  NekInteractionFrame,
} from "@zcode/shared/nek-protocol";
import { useNekInteractionStore, type NekInteractionStoreApi } from "@/nek/interactions/interactionStore.js";
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
  return JSON.stringify([target.workspacePath, target.workspaceIdentity ?? "", target.remoteSessionId ?? ""]);
}

function frameSessionKey(frame: NekInteractionFrame, target: NekAgentFeedTarget): string {
  return frame.scope.sessionId ?? frame.scope.sessionKey ?? target.workspacePath;
}

function isPendingRequest(store: NekInteractionStoreApi, id: string): boolean {
  return Object.values(store.getState().sessions).some((session) =>
    session.queue.some((record) => record.request.id === id),
  );
}

function createNekAgentFeed(
  service: NekAgentFeedService,
  target: NekAgentFeedTarget,
  store: NekInteractionStoreApi,
): FeedEntry {
  const sessionKeys = new Set<string>([target.workspacePath]);
  let subscription: IDisposable | undefined;
  const ingest = (frame: NekInteractionFrame): void => {
    const sessionKey = frameSessionKey(frame, target);
    sessionKeys.add(sessionKey);
    if (frame.kind === "request") {
      store.getState().enqueueExtensionRequest(sessionKey, frame.request);
      return;
    }
    store.getState().cancelByHost(sessionKey, frame.id);
  };
  const feed: NekAgentFeed = {
    respond: async ({ requestId, response }) => {
      try {
        await service.respondNekInteraction({ requestId, response });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no longer pending|unknown interaction/u.test(message)) {
          // The bridge's false/unknown-id result means nek already cancelled this request.
          // Remove the stale card before surfacing the error to the controller.
          for (const sessionKey of sessionKeys) {
            store.getState().cancelByHost(sessionKey, requestId);
          }
          throw new Error(`Interaction ${requestId} is no longer pending: ${message}`);
        }
        // A transport failure must leave the request in the queue; the controller can show
        // its error state and retry the same response.
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
    for (const sessionKey of sessionKeys) store.getState().disconnect(sessionKey);
    sessionKeys.clear();
  };
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
  let entry = serviceEntries?.get(key);
  if (!entry) {
    const nextEntries = serviceEntries ?? new Map<string, FeedEntry>();
    entry = createNekAgentFeed(service, target, store);
    nextEntries.set(key, entry);
    feedEntries.set(service, nextEntries);
  } else {
    entry.refs += 1;
  }
  let released = false;
  return {
    feed: entry.feed,
    release: () => {
      if (released) return;
      released = true;
      entry!.refs -= 1;
      if (entry!.refs > 0) return;
      entry!.dispose();
      const entries = feedEntries.get(service);
      entries?.delete(key);
      if (entries?.size === 0) feedEntries.delete(service);
    },
  };
}

const NekAgentFeedContext = createContext<NekAgentFeed | null>(null);

export interface NekAgentFeedProviderProps {
  service: NekAgentFeedService;
  target: NekAgentFeedTarget;
  children: ReactNode;
}

export function NekAgentFeedProvider({ service, target, children }: NekAgentFeedProviderProps) {
  const lease = useMemo(() => acquireNekAgentFeed(service, target), [service, target]);
  useEffect(() => () => lease.release(), [lease]);
  return createElement(NekAgentFeedContext.Provider, { value: lease.feed }, children);
}

/** Optional so static/replay views can keep the existing headless controllers. */
export function useOptionalNekAgentFeed(): NekAgentFeed | null {
  return useContext(NekAgentFeedContext);
}

export function useNekAgentFeed(): NekAgentFeed {
  const feed = useOptionalNekAgentFeed();
  if (!feed) throw new Error("useNekAgentFeed must be used inside NekAgentFeedProvider");
  return feed;
}

export const NEK_AGENT_FEED_METHODS = [
  "onDynamicNekInteractionFrame",
  "respondNekInteraction",
  "stopSubagent",
  "getSubagentTranscript",
  "listAgentTypes",
] as const satisfies readonly (keyof WorkspaceConnectionAgentService)[];

export function hasPendingInteraction(store: NekInteractionStoreApi, requestId: string): boolean {
  return isPendingRequest(store, requestId);
}
