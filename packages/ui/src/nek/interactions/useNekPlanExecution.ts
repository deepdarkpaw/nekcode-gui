import { useCallback, useEffect, useMemo, useRef } from "react";
import type {
  CommandAck,
  CommandPayloadMap,
  ConversationSnapshot,
  NekPlanRevision,
} from "@zcode/shared/zcode-protocol-v4";
import { useNekInteractionStore } from "./interactionStore.js";

type PlanExecution = CommandPayloadMap["executeNekPlan"];

export function useNekPlanExecution({
  sessionId,
  scopeKey,
  snapshot,
  readOnly,
  dispatch,
  onOpenSession,
}: {
  sessionId: string | null;
  scopeKey: string;
  snapshot: Pick<ConversationSnapshot, "sessionId" | "config" | "control"> | null;
  readOnly: boolean;
  dispatch: (
    type: "executeNekPlan",
    payload: PlanExecution,
    sessionId: string,
  ) => Promise<CommandAck>;
  onOpenSession?: (sessionId: string) => void;
}) {
  const waiting = useNekInteractionStore(
    (state) => sessionId !== null && (state.sessions[sessionId]?.queue.length ?? 0) > 0,
  );
  const owner = useMemo(() => ({ scopeKey, sessionId }), [scopeKey, sessionId]);
  const mounted = useRef<typeof owner | null>(null);
  useEffect(() => {
    mounted.current = owner;
    return () => {
      mounted.current = null;
    };
  }, [owner]);
  const ready =
    snapshot?.sessionId === sessionId &&
    !readOnly &&
    !waiting &&
    !snapshot.control.readOnly &&
    !snapshot.control.canStop &&
    snapshot.control.phase !== "running"
      ? snapshot.config.nekReadyPlan
      : undefined;
  const run = useCallback(
    async (revision: NekPlanRevision, fresh: boolean) => {
      if (!sessionId || mounted.current !== owner)
        throw new Error("Plan session is no longer active");
      const ack = await dispatch("executeNekPlan", { ...revision, fresh }, sessionId);
      if (ack.status !== "accepted" && ack.status !== "duplicate")
        throw new Error(ack.message ?? ack.reasonCode ?? ack.status);
      if (ack.result?.type !== "executeNekPlan")
        throw new Error("nek plan execution result is missing");
      if (ack.result.sessionId && mounted.current === owner) onOpenSession?.(ack.result.sessionId);
    },
    [dispatch, onOpenSession, owner, sessionId],
  );
  return useMemo(() => (ready ? { ...ready, run } : undefined), [ready, run]);
}
