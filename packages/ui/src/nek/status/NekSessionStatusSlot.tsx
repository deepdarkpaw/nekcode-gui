import { useEffect } from "react";
import { NekCompactionBannerView } from "./NekCompactionBannerView.js";
import { NekQueueBarView } from "./NekQueueBarView.js";
import { NekRetryBannerView } from "./NekRetryBannerView.js";
import { NekSubagentStatusSection } from "./NekSubagentStatusSection.js";
import { NekTodoPanelView } from "./NekTodoPanelView.js";
import { NekUsageIndicatorView } from "./NekUsageIndicatorView.js";
import { useNekStatusActions } from "@/nek/statusFeed/statusActions.js";
import { useNekStatusStore } from "./store.js";

/**
 * 状态卡需要的 pane 级回调：需要 composer / 侧栏 / 行跳转的那部分动作。
 * 只依赖 agent 服务的动作（abort / compact / 队列）由 status feed 登记，
 * 见 `statusFeed/statusActions.ts`，pane 不转发。
 */
export interface NekSessionStatusCallbacks {
  onStopSubagent: (id: string) => Promise<void>;
  onFocusSubagent: (id: string) => void;
  onOpenPlan: (path: string) => Promise<void> | void;
  onJumpToTodo: (id: string) => void;
  canJumpToTodo: (id: string) => boolean;
  getComposerText: () => string;
  setComposerText: (text: string) => void;
  focusComposerAtEnd: () => void;
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
  // 没有登记（feed 还没见过这个会话）时不渲染需要 RPC 的视图，避免用空实现假装成功。
  const statusActions = useNekStatusActions(sessionKey);
  const active = useNekStatusStore((state) => {
    const status = state.sessions[sessionKey];
    if (!status) return false;
    return (
      status.subagents.order.length > 0 ||
      status.todos.length > 0 ||
      status.queue.steering.length > 0 ||
      status.queue.followUp.length > 0 ||
      status.retry !== null ||
      status.compaction !== null ||
      status.stats !== undefined
    );
  });
  if (!active || !statusActions) return null;
  return (
    <div data-status-view="session-status-slot" className="flex min-w-0 flex-col gap-1.5">
      <NekRetryBannerView
        sessionKey={sessionKey}
        abortRetry={statusActions.abortRetry}
        abort={statusActions.abort}
      />
      <NekCompactionBannerView
        sessionKey={sessionKey}
        abortCompaction={statusActions.abortCompaction}
      />
      <NekTodoPanelView
        sessionKey={sessionKey}
        onOpenPlan={callbacks.onOpenPlan}
        onJumpToTodo={callbacks.onJumpToTodo}
        canJumpToTodo={callbacks.canJumpToTodo}
      />
      <NekSubagentStatusSection
        sessionKey={sessionKey}
        onStop={callbacks.onStopSubagent}
        onOpenTranscript={callbacks.onFocusSubagent}
      />
      <NekQueueBarView
        sessionKey={sessionKey}
        clearQueue={statusActions.clearQueue}
        requeue={statusActions.requeue}
        getComposerText={callbacks.getComposerText}
        setComposerText={callbacks.setComposerText}
        focusComposerAtEnd={callbacks.focusComposerAtEnd}
      />
      <NekUsageIndicatorView sessionKey={sessionKey} onCompact={statusActions.compact} />
    </div>
  );
}
