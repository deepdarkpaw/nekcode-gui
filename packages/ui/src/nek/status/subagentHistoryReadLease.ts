import {
  assertHistoryObservation,
  type ConversationHistoryObservation,
  type ConversationHistoryWatermark,
} from "@zcode/shared/zcode-protocol-v4";
import { assertChildWatermark } from "./subagentHistoryBody.js";
import type {
  SubagentHistoryClock,
  SubagentHistoryScope,
  SubagentHistoryService,
} from "./subagentHistoryTypes.js";
import { NEK_STATUS_TRANSCRIPT_REFRESH_MS } from "./types.js";

/** One cancelable timer lease; the controller alone decides whether polling is allowed. */
export function createSubagentHistoryPollTimer(clock: SubagentHistoryClock, poll: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  return {
    clear,
    schedule(enabled: boolean) {
      clear();
      if (enabled)
        timer = clock.setTimeout(() => {
          timer = undefined;
          poll();
        }, NEK_STATUS_TRANSCRIPT_REFRESH_MS);
    },
  };
}

/** Observe the existing trusted workspace runtime without opening/resuming a child. */
export function observeSubagentHistoryRuntime(
  service: SubagentHistoryService,
  scope: SubagentHistoryScope,
  invalidate: () => void,
): () => void {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  const lease = service.onAgentRuntimeLifecycle
    ? service.onAgentRuntimeLifecycle((event) => {
        if (event.workspaceKey === workspaceKey && event.state === "unavailable") invalidate();
      })
    : service.onAgentRuntimeRestarted((event) => {
        if (event.workspaceKey === workspaceKey) invalidate();
      });
  return () => lease.dispose();
}

/** Small independent metadata/content admission budget, not a completed-read cache. */
const MAX_AUXILIARY_READS = 4;
export function createSubagentHistoryReadLease(owner: {
  active(): boolean;
  key(): string;
  watermark(): ConversationHistoryWatermark | undefined;
  observation(): ConversationHistoryObservation | undefined;
}) {
  const pending = new Set<object>();
  return {
    clear: () => pending.clear(),
    async read<T extends ConversationHistoryWatermark & ConversationHistoryObservation>(
      read: () => Promise<T>,
      observationCursor?: string,
    ): Promise<T> {
      if (!owner.active() || pending.size >= MAX_AUXILIARY_READS)
        throw new Error("Child history read is unavailable or busy");
      const key = owner.key();
      const watermark = owner.watermark();
      const observation = owner.observation();
      const token = {};
      pending.add(token);
      try {
        const result = await read();
        if (!owner.active()) throw new Error("Child history owner is no longer active");
        if (key !== owner.key()) throw new Error("Child history owner changed during read");
        assertChildWatermark(result, watermark);
        if (observation) assertHistoryObservation(observation, result, observationCursor);
        return result;
      } finally {
        pending.delete(token);
      }
    },
  };
}
