import type { QueueContents } from "./queue.js";
import { NekCompactionBannerView } from "./NekCompactionBannerView.js";
import { NekQueueBarView } from "./NekQueueBarView.js";
import { NekRetryBannerView } from "./NekRetryBannerView.js";
import { NekRunningSubagentsBarView } from "./NekRunningSubagentsBarView.js";
import { NekTodoPanelView } from "./NekTodoPanelView.js";
import { NekUsageIndicatorView } from "./NekUsageIndicatorView.js";
import { getNekStatusActions } from "@/nek/statusFeed/statusFeed.js";
import { useNekStatusStore } from "./store.js";

export interface NekSessionStatusCallbacks {
  onStopSubagent: (id: string) => Promise<void>;
  onStopAllSubagents?: (ids: string[]) => Promise<void>;
  onFocusSubagent: (id: string) => void;
  onOpenPlan: (path: string) => Promise<void> | void;
  onJumpToTodo: (id: string) => void;
  canJumpToTodo: (id: string) => boolean;
  clearQueue: () => Promise<QueueContents>;
  requeue: (queue: QueueContents) => Promise<void>;
  getComposerText: () => string;
  setComposerText: (text: string) => void;
  focusComposerAtEnd: () => void;
  abortRetry: () => Promise<void>;
  abort: () => Promise<void>;
  abortCompaction: () => Promise<void>;
  onCompact: () => Promise<void>;
}

export interface NekSessionStatusSlotProps {
  sessionKey: string;
  callbacks: NekSessionStatusCallbacks;
}

export function NekSessionStatusSlot({ sessionKey, callbacks }: NekSessionStatusSlotProps) {
  const statusActions = getNekStatusActions(sessionKey);
  const effectiveCallbacks = statusActions
    ? {
        ...callbacks,
        clearQueue: statusActions.clearQueue,
        requeue: statusActions.requeue,
        abortRetry: statusActions.abortRetry,
        abortCompaction: statusActions.abortCompaction,
        onCompact: statusActions.compact,
      }
    : callbacks;
  const active = useNekStatusStore((state) => {
    const status = state.sessions[sessionKey];
    if (!status) return false;
    return (
      status.todos.length > 0 ||
      status.queue.steering.length > 0 ||
      status.queue.followUp.length > 0 ||
      status.retry !== null ||
      status.compaction !== null ||
      status.stats !== undefined ||
      status.subagents.order.some((id) => status.subagents.byId[id]?.status === "running")
    );
  });
  if (!active) return null;
  return (
    <div data-status-view="session-status-slot" className="flex min-w-0 flex-col gap-1.5">
      <NekRetryBannerView
        sessionKey={sessionKey}
        abortRetry={effectiveCallbacks.abortRetry}
        abort={effectiveCallbacks.abort}
      />
      <NekCompactionBannerView
        sessionKey={sessionKey}
        abortCompaction={effectiveCallbacks.abortCompaction}
      />
      <NekTodoPanelView
        sessionKey={sessionKey}
        onOpenPlan={effectiveCallbacks.onOpenPlan}
        onJumpToTodo={effectiveCallbacks.onJumpToTodo}
        canJumpToTodo={effectiveCallbacks.canJumpToTodo}
      />
      <NekQueueBarView
        sessionKey={sessionKey}
        clearQueue={effectiveCallbacks.clearQueue}
        requeue={effectiveCallbacks.requeue}
        getComposerText={effectiveCallbacks.getComposerText}
        setComposerText={effectiveCallbacks.setComposerText}
        focusComposerAtEnd={effectiveCallbacks.focusComposerAtEnd}
      />
      <NekRunningSubagentsBarView
        sessionKey={sessionKey}
        onStop={effectiveCallbacks.onStopSubagent}
        onStopAll={effectiveCallbacks.onStopAllSubagents}
        onFocusSubagent={effectiveCallbacks.onFocusSubagent}
      />
      <NekUsageIndicatorView sessionKey={sessionKey} onCompact={effectiveCallbacks.onCompact} />
    </div>
  );
}
