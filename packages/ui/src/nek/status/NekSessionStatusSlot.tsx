import { useEffect, useState } from "react";
import type { QueueContents } from "./queue.js";
import { NekCompactionBannerView } from "./NekCompactionBannerView.js";
import { NekQueueBarView } from "./NekQueueBarView.js";
import { NekRetryBannerView } from "./NekRetryBannerView.js";
import { NekRunningSubagentsBarView } from "./NekRunningSubagentsBarView.js";
import { NekTodoPanelView } from "./NekTodoPanelView.js";
import { NekUsageIndicatorView } from "./NekUsageIndicatorView.js";
import { NekSubagentCardView } from "./NekSubagentCardView.js";
import { NekSubagentTranscriptView } from "./NekSubagentTranscriptView.js";
import { useNekStatusActions } from "@/nek/statusFeed/statusActions.js";
import { useNekStatusStore } from "./store.js";

export interface NekSessionStatusCallbacks {
  onStopSubagent: (id: string) => Promise<void>;
  onStopAllSubagents?: (ids: string[]) => Promise<void>;
  fetchTranscript: (id: string) => Promise<{ messages: unknown[] }>;
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
  // ST-5：把当前打开的会话标为 current，store 的 LRU 淘汰不会把它挤掉。
  useEffect(() => {
    useNekStatusStore.getState().setCurrentSession(sessionKey);
  }, [sessionKey]);
  // 只依赖 agent 服务的动作由 status feed 直接提供（定义见 statusFeed/statusActions.ts）；
  // pane 传入的 callbacks 负责需要 composer / 侧栏 / 行跳转的那几个动作。
  const statusActions = useNekStatusActions(sessionKey);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const effectiveCallbacks = statusActions
    ? {
        ...callbacks,
        clearQueue: statusActions.clearQueue,
        requeue: statusActions.requeue,
        abort: statusActions.abort,
        abortRetry: statusActions.abortRetry,
        abortCompaction: statusActions.abortCompaction,
        onCompact: statusActions.compact,
      }
    : callbacks;
  const subagentIds = useNekStatusStore(
    (state) => state.sessions[sessionKey]?.subagents.order ?? [],
  );
  const active = useNekStatusStore((state) => {
    const status = state.sessions[sessionKey];
    if (!status) return false;
    return (
      subagentIds.length > 0 ||
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
      {transcriptId ? (
        <NekSubagentTranscriptView
          sessionKey={sessionKey}
          id={transcriptId}
          fetchTranscript={effectiveCallbacks.fetchTranscript}
          onBack={() => setTranscriptId(null)}
        />
      ) : (
        subagentIds.map((id) => (
          <NekSubagentCardView
            key={id}
            sessionKey={sessionKey}
            id={id}
            onStop={effectiveCallbacks.onStopSubagent}
            onOpenTranscript={setTranscriptId}
          />
        ))
      )}
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
