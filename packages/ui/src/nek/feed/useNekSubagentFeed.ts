import { useMemo } from "react";
import {
  createNekSubagentControllerFeed,
  useNekAgentFeed,
  useNekAgentFeedTarget,
  type NekAgentFeed,
  type NekSubagentControllerFeed,
} from "./nekAgentFeed.js";

/**
 * 子代理控制器需要的三条 RPC，注入点就是三个控制器的 props：
 *
 * | 控制器 | 注入点 | 来源 |
 * | --- | --- | --- |
 * | `useSubagentCardController` | `onStop` | `stopSubagent` |
 * | `useSubagentTranscriptController` | `fetchTranscript` | `getSubagentTranscript` |
 * | 自 agent 类型选择器（mention 候选等） | `listAgentTypes` | `listAgentTypes` |
 *
 * `onOpenTranscript` / `onFocusSubagent` 是纯界面导航，不在这里。
 */
/**
 * 把子代理 RPC 接到 feed 的传输上；`sessionId` 来自当前 pane 已打开的会话，
 * 没有会话时调用方不应挂载子代理视图（RPC 需要 sessionId 才能命中 nek 会话进程）。
 */
export function useNekSubagentFeed(sessionId: string): NekSubagentControllerFeed {
  const feed: NekAgentFeed = useNekAgentFeed();
  const target = useNekAgentFeedTarget();
  return useMemo(
    () => createNekSubagentControllerFeed(feed, target, sessionId),
    [feed, sessionId, target],
  );
}
