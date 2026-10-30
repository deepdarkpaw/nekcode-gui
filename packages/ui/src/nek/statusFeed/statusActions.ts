import { useSyncExternalStore } from "react";
import type { NekStatusQueue } from "@zcode/shared/nek-protocol";

/**
 * 状态视图动作的数据面注册表。
 *
 * 状态卡只认识"回调"：`NekSessionStatusSlot` 把这里的 handle 叠到 pane 传入的 callbacks 上，
 * 因此 abortRetry / abortCompaction / compact / 队列取回这些只依赖 agent 服务的动作
 * 不需要 pane 逐层转发。注册表有界：feed 只为它见过的会话登记，超出上限先摘最旧的会话。
 */

/** nek status feed 能为一个会话提供的动作；全部直接落到 nek RPC。 */
export interface NekStatusActions {
  /** 中止当前回合（重试横幅里 kind=summarization 的取消共用）。 */
  abort: () => Promise<void>;
  abortRetry: () => Promise<void>;
  abortCompaction: () => Promise<void>;
  compact: () => Promise<void>;
  clearQueue: () => Promise<NekStatusQueue>;
  requeue: (queue: NekStatusQueue) => Promise<void>;
}

const actionsBySession = new Map<string, NekStatusActions>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** 只由 feed 调用：登记/覆盖一个会话的动作。 */
export function setNekStatusActions(sessionKey: string, actions: NekStatusActions): void {
  const previous = actionsBySession.get(sessionKey);
  if (previous === actions) return;
  actionsBySession.set(sessionKey, actions);
  notify();
}

/** 只由 feed 调用：会话关闭、被淘汰或 feed 释放时摘掉动作。 */
export function deleteNekStatusActions(sessionKey: string): void {
  if (!actionsBySession.delete(sessionKey)) return;
  notify();
}

/** 非 React 调用方（测试、诊断）用这个同步读取。 */
export function getNekStatusActions(sessionKey: string): NekStatusActions | undefined {
  return actionsBySession.get(sessionKey);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 渲染层订阅某个会话的动作是否已经可用（feed 迟于首帧到达时也要更新）。 */
export function useNekStatusActions(sessionKey: string): NekStatusActions | undefined {
  return useSyncExternalStore(subscribe, () => actionsBySession.get(sessionKey));
}

/** 测试与 workspace 换代时清空全部登记。 */
export function resetNekStatusActionRegistry(): void {
  if (actionsBySession.size === 0) return;
  actionsBySession.clear();
  notify();
}

/** 当前登记的会话数（诊断/测试用）。 */
export function nekStatusActionSessionCount(): number {
  return actionsBySession.size;
}
