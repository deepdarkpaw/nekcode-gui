import type { ConversationHistoryWatermark } from "@zcode/shared/zcode-protocol-v4";
import { assertChildWatermark } from "./subagentHistoryBody.js";
import type { SubagentHistoryScope, SubagentHistoryService } from "./subagentHistoryTypes.js";

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
}) {
  const pending = new Set<object>();
  return {
    clear: () => pending.clear(),
    async read<T extends ConversationHistoryWatermark>(read: () => Promise<T>): Promise<T> {
      if (!owner.active() || pending.size >= MAX_AUXILIARY_READS)
        throw new Error("Child history read is unavailable or busy");
      const key = owner.key();
      const watermark = owner.watermark();
      const token = {};
      pending.add(token);
      try {
        const result = await read();
        if (!owner.active()) throw new Error("Child history owner is no longer active");
        if (key !== owner.key()) throw new Error("Child history owner changed during read");
        assertChildWatermark(result, watermark);
        return result;
      } finally {
        pending.delete(token);
      }
    },
  };
}
