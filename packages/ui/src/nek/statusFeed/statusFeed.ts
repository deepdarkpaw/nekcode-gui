import type { IDisposable } from "@zcode/rpc";
import type { NekStatusFrame, NekStatusQueue } from "@zcode/shared/nek-protocol";
import type {
  IZCodeAgentService,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { useNekStatusStore } from "@/nek/status/store.js";
import type { NekStatusStoreStateWithSession } from "@/nek/status/store.js";

export type NekStatusFeedAgentService = Pick<
  IZCodeAgentService,
  | "onDynamicNekStatusFrame"
  | "getNekSessionStats"
  | "clearNekQueue"
  | "requeueNekQueue"
  | "abortNekRetry"
  | "abortNekCompaction"
  | "compactNekSession"
>;

export interface NekStatusActions {
  clearQueue: () => Promise<NekStatusQueue>;
  requeue: (queue: NekStatusQueue) => Promise<void>;
  abortRetry: () => Promise<void>;
  abortCompaction: () => Promise<void>;
  compact: () => Promise<void>;
}

const actionsBySession = new Map<string, NekStatusActions>();

export function getNekStatusActions(sessionKey: string): NekStatusActions | undefined {
  return actionsBySession.get(sessionKey);
}

export interface NekStatusFeedHandle {
  dispose: () => void;
}

function sessionTarget(
  target: ZCodeAgentWorkspaceTarget,
  sessionId: string,
): ZCodeAgentSessionTarget {
  return { ...target, sessionId };
}

function installActions(
  agentService: NekStatusFeedAgentService,
  target: ZCodeAgentWorkspaceTarget,
  sessionKey: string,
): void {
  const input = () => sessionTarget(target, sessionKey);
  actionsBySession.set(sessionKey, {
    clearQueue: () => agentService.clearNekQueue(input()),
    requeue: (queue) => agentService.requeueNekQueue({ ...input(), queue }),
    abortRetry: () => agentService.abortNekRetry(input()),
    abortCompaction: () => agentService.abortNekCompaction(input()),
    compact: () => agentService.compactNekSession(input()),
  });
}

function consumeSnapshot(
  store: NekStatusStoreStateWithSession,
  frame: Extract<NekStatusFrame, { kind: "snapshot" }>,
): void {
  const now = Date.now();
  const { sessionKey, snapshot } = frame;
  store.consumeEvent(sessionKey, { type: "session_opened" }, now);
  store.consumeEvent(sessionKey, { type: "nek.state", payload: snapshot.state }, now);
  store.consumeEvent(
    sessionKey,
    snapshot.running ? { type: "agent_start" } : { type: "agent_settled" },
    now,
  );
  store.consumeEvent(sessionKey, { type: "session_stats", payload: snapshot.stats }, now);
}

function consumeEvent(
  agentService: NekStatusFeedAgentService,
  target: ZCodeAgentWorkspaceTarget,
  frame: Extract<NekStatusFrame, { kind: "event" }>,
  refreshVersions: Map<string, number>,
): void {
  const store = useNekStatusStore.getState();
  installActions(agentService, target, frame.sessionKey);
  const output = store.consumeEvent(frame.sessionKey, frame.event);
  if (!output.needsStatsRefresh || !store.flushStatsRefresh(frame.sessionKey)) return;
  const version = (refreshVersions.get(frame.sessionKey) ?? 0) + 1;
  refreshVersions.set(frame.sessionKey, version);
  void agentService
    .getNekSessionStats(sessionTarget(target, frame.sessionKey))
    .then((stats) => {
      if (refreshVersions.get(frame.sessionKey) !== version) return;
      useNekStatusStore.getState().setStats(frame.sessionKey, stats);
    })
    .catch((error: unknown) => {
      logger.warn("failed to refresh nek status stats", {
        error: error instanceof Error ? error.message : String(error),
        sessionKey: frame.sessionKey,
      });
    });
}

export function createNekStatusFeed(
  agentService: NekStatusFeedAgentService,
  target: ZCodeAgentWorkspaceTarget,
): NekStatusFeedHandle {
  const refreshVersions = new Map<string, number>();
  const ownedSessionKeys = new Set<string>();
  const disposable: IDisposable = agentService.onDynamicNekStatusFrame(target)((frame) => {
    ownedSessionKeys.add(frame.sessionKey);
    installActions(agentService, target, frame.sessionKey);
    if (frame.kind === "snapshot") consumeSnapshot(useNekStatusStore.getState(), frame);
    else consumeEvent(agentService, target, frame, refreshVersions);
  });
  return {
    dispose: () => {
      disposable.dispose();
      for (const sessionKey of ownedSessionKeys) {
        actionsBySession.delete(sessionKey);
        useNekStatusStore.getState().removeSession(sessionKey);
      }
      ownedSessionKeys.clear();
      refreshVersions.clear();
    },
  };
}

export function resetNekStatusFeedRegistry(): void {
  actionsBySession.clear();
}
