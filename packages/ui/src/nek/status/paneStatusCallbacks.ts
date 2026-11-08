/**
 * `NekSessionStatusSlot` 的 pane 级回调装配。
 *
 * 状态卡需要的动作分两类：
 * - **只依赖 agent 服务**的（abort / abortRetry / abortCompaction / compact / clearQueue /
 *   requeue）由 status feed 登记进 `statusActions` 注册表，槽位自己叠加，pane 不转发；
 * - **需要 pane 上下文**的（子代理 RPC、计划侧栏、todo 跳转、composer 读写与聚焦）由本工厂
 *   把 pane 的真实实现装成回调对象，`SessionPane` 因此不需要写一串 `?? async () => undefined`
 *   的空实现。
 */
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { NekSessionStatusCallbacks } from "./NekSessionStatusSlot.js";

export interface NekPaneStatusCallbackSources {
  /** workspace identity + session 的草稿范围；异步取回不能跨远端回填。 */
  composerScopeKey?: string;
  /** 子代理停止（`stopSubagent`），来自 `useNekSubagentFeed`。 */
  stopSubagent: (id: string) => Promise<void>;
  /** 定位到对话里的子代理（打开对应子会话）。 */
  focusSubagent: (id: string) => void;
  /** 打开计划文件（复用文件链接通道）。 */
  openPlan: (path: string) => Promise<void> | void;
  /** todo 项跳转。 */
  jumpToTodo: (id: string) => void;
  /** 某条 todo 当前是否可跳转。 */
  canJumpToTodo: (id: string) => boolean;
  /** 读取当前草稿文本（队列取回要拼在它前面）。 */
  getComposerText: () => string;
  /** 替换输入框文本（队列取回）。 */
  setComposerText: (text: string) => void;
  /** 队列文件回到当前会话的附件 owner；拒绝时保持队列内容可重试。 */
  restoreComposerAttachments?: (attachments: readonly AttachmentRef[]) => boolean;
  /** 把焦点移到输入框末尾。 */
  focusComposerAtEnd: () => void;
}

export function createNekPaneStatusCallbacks(
  sources: NekPaneStatusCallbackSources,
): NekSessionStatusCallbacks {
  return {
    ...(sources.composerScopeKey ? { composerScopeKey: sources.composerScopeKey } : {}),
    onStopSubagent: async (id) => await sources.stopSubagent(id),
    onFocusSubagent: sources.focusSubagent,
    onOpenPlan: sources.openPlan,
    onJumpToTodo: sources.jumpToTodo,
    canJumpToTodo: sources.canJumpToTodo,
    getComposerText: sources.getComposerText,
    setComposerText: sources.setComposerText,
    ...(sources.restoreComposerAttachments
      ? { restoreComposerAttachments: sources.restoreComposerAttachments }
      : {}),
    focusComposerAtEnd: sources.focusComposerAtEnd,
  };
}
